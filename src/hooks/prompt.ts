#!/usr/bin/env node
/**
 * UserPromptSubmit hook — auto-inject relevant memories into every prompt.
 *
 * Turns memorex from "tool Claude must remember to call" into "passive memory
 * layer always on". On every user prompt:
 *
 *   1. Read the incoming prompt from Claude Code's hook stdin JSON.
 *   2. Skip memory IDs already injected in this session's recent history
 *      (LRU dedup) so we don't pay to re-inject the same context every turn.
 *   3. Run a budget-capped FTS search against memories scoped to this project
 *      with an adaptive budget sized to the prompt.
 *   4. Emit top matches on stdout in a compact wrapper — Claude Code appends
 *      them to the prompt as additional context.
 *
 * Guarantees:
 *   - Never blocks the user: every failure exits silently with code 0.
 *   - Zero-cost when there are no relevant memories (prints nothing).
 *   - Does NOT refresh accessed_at on matches — auto-injection shouldn't
 *     artificially extend the life of otherwise-cold memories.
 *   - Adaptive token budget: short prompts get smaller budgets, long ones
 *     get more. Tunable via MEMOREX_INJECT_BUDGET env (caps the ceiling).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDb, getDbReadonly } from '../db/index.js';
import { scoreMemory, estimateTokens, type Memory } from '../types/scoring.js';
import { PATHS, SCORING } from '../utils/config.js';
import { getProjectRoot } from '../utils/project.js';
import { sanitizeFtsQuery } from '../utils/security.js';

// ---- Analytics ------------------------------------------------------------

interface InjectEvent {
  status: 'inject' | 'skip-empty' | 'skip-dedup' | 'skip-error';
  sessionId: string;
  project: string;
  memoryIds: number[];
  tokens: number;
  budget: number;
  promptChars: number;
}

/**
 * Persist a single inject event to the `inject_events` table for `memorex gain`.
 * Best-effort — never blocks the hook. Opens a writable handle briefly because
 * the readonly handle used for search can't write. Total cost ~1ms warm, which
 * we eat once per prompt to feed analytics.
 *
 * We log both successful injects and skips so `gain` can compute the real
 * coverage rate ("of N prompts this week, X% had matching context").
 */
function logInjectEvent(ev: InjectEvent): void {
  let writable: ReturnType<typeof getDb> | null = null;
  try {
    writable = getDb();
    writable
      .prepare(
        `INSERT INTO inject_events
           (session_id, project, memory_ids, tokens, budget, prompt_chars, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ev.sessionId || null,
        ev.project || null,
        JSON.stringify(ev.memoryIds),
        ev.tokens,
        ev.budget,
        ev.promptChars,
        ev.status
      );
  } catch {
    /* analytics is best-effort; never break the hook */
  } finally {
    try {
      writable?.close();
    } catch {
      /* noop */
    }
  }
}

// ---- Budget tuning --------------------------------------------------------

const INJECT_BUDGET_CEILING = Number(process.env.MEMOREX_INJECT_BUDGET ?? '500');
const INJECT_MIN_SCORE = Number(process.env.MEMOREX_INJECT_MIN_SCORE ?? '0.15');
const INJECT_MAX_RESULTS = Number(process.env.MEMOREX_INJECT_MAX ?? '3');
const INJECT_FETCH_LIMIT = Math.max(8, INJECT_MAX_RESULTS * 4);

/**
 * Scale the token budget with prompt length. Very short prompts ("continue",
 * "yes") don't need much context; long detailed prompts benefit from more.
 * Formula: 180 + 0.5 * chars, clamped to [200, ceiling].
 */
function adaptiveBudget(promptLength: number): number {
  const scaled = Math.round(180 + promptLength * 0.5);
  return Math.max(200, Math.min(INJECT_BUDGET_CEILING, scaled));
}

// ---- Session-scoped LRU dedup --------------------------------------------

/** Cap on how many recently-injected IDs we remember per session. */
const LRU_CAP = 20;
/** Entries older than this are evicted on read. Matches session TTL. */
const LRU_TTL_SECONDS = 4 * 3600;
const LRU_FILE = join(PATHS.DB_DIR, 'inject-lru.json');

interface LruEntry {
  ids: number[];
  at: number;
}
type LruStore = Record<string, LruEntry>;

function readLru(): LruStore {
  try {
    if (!existsSync(LRU_FILE)) return {};
    const parsed = JSON.parse(readFileSync(LRU_FILE, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as LruStore;
    }
  } catch {
    /* fall through — treat corrupt cache as empty */
  }
  return {};
}

function writeLru(store: LruStore): void {
  try {
    writeFileSync(LRU_FILE, JSON.stringify(store), { mode: 0o600 });
  } catch {
    /* best-effort — LRU is optimization, not correctness */
  }
}

function gcLru(store: LruStore, now: number): void {
  for (const [key, entry] of Object.entries(store)) {
    if (now - entry.at > LRU_TTL_SECONDS) delete store[key];
  }
}

// ---- Inject format --------------------------------------------------------

// Compact wrapper. Old wrapper was ~55 chars of XML per injection; this is 19.
const PREAMBLE = '<memorex>';
const POSTAMBLE = '</memorex>';

/** Per-memory compact format: `1/P Title: body`. Tighter than the default
 *  search format (`#1 P:Title|body`) which is used for MCP responses. */
function formatInjection(m: Memory, maxBody: number): string {
  let body = m.body;
  if (body.length > maxBody) {
    const truncated = body.slice(0, maxBody);
    const lastSentence = truncated.match(/.*[.!?]\s*/);
    body = (lastSentence ? lastSentence[0].trim() : truncated) + '…';
  }
  const type = m.type[0].toUpperCase();
  return `${m.id}/${type} ${m.title}: ${body}`;
}

// ---- Hook plumbing --------------------------------------------------------

function readStdinSync(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

interface HookPayload {
  prompt?: unknown;
  session_id?: unknown;
  hook_event_name?: unknown;
}

function extractPayload(raw: string): { prompt: string; sessionId: string } {
  if (!raw) return { prompt: '', sessionId: '' };
  try {
    const parsed = JSON.parse(raw) as HookPayload;
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id.slice(0, 64) : '',
    };
  } catch {
    // Non-JSON stdin — some harnesses pipe raw text. No session id available.
    return { prompt: raw, sessionId: '' };
  }
}

function main(): void {
  const raw = readStdinSync();
  const { prompt: promptRaw, sessionId } = extractPayload(raw);
  const prompt = promptRaw.slice(0, 2000); // cap to avoid FTS DoS
  if (!prompt.trim()) return;

  const safe = sanitizeFtsQuery(prompt);
  if (!safe || safe === '*') return;

  const project = getProjectRoot();
  const now = Math.floor(Date.now() / 1000);
  const budget = adaptiveBudget(prompt.length);

  const db = getDbReadonly();
  if (!db) {
    // DB missing — can't search OR log. Truly silent fresh-install path.
    return;
  }

  // Load LRU for this session — the "already shown recently" exclusion list.
  const lruStore = sessionId ? readLru() : {};
  if (sessionId) gcLru(lruStore, now);
  const excludedIds = sessionId ? new Set(lruStore[sessionId]?.ids ?? []) : new Set<number>();

  try {
    const { title: wt, body: wb, tags: wtags } = SCORING.BM25_WEIGHTS;
    const rows = db
      .prepare(
        `
      SELECT m.*, bm25(memories_fts, ${wt}, ${wb}, ${wtags}) as fts_rank
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ?
        AND (m.project IS NULL OR m.project = ? OR ? LIKE m.project || '/%')
        AND (m.expires_at IS NULL OR m.expires_at > ?)
      ORDER BY fts_rank
      LIMIT ?
    `
      )
      .all(safe, project, project, now, INJECT_FETCH_LIMIT) as (Memory & {
      fts_rank: number;
    })[];

    if (rows.length === 0) {
      logInjectEvent({
        status: 'skip-empty',
        sessionId,
        project,
        memoryIds: [],
        tokens: 0,
        budget,
        promptChars: prompt.length,
      });
      return;
    }

    const scored = rows
      .filter((r) => !excludedIds.has(r.id))
      .map((r) => ({ mem: r, score: scoreMemory(r, r.fts_rank) }))
      .filter((x) => x.score >= INJECT_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, INJECT_MAX_RESULTS);

    if (scored.length === 0) {
      // Distinguish dedup-killed from min-score-killed: if rows existed but
      // we excluded everything via LRU, the "next prompt" already saw them.
      const status = excludedIds.size > 0 ? 'skip-dedup' : 'skip-empty';
      logInjectEvent({
        status,
        sessionId,
        project,
        memoryIds: [],
        tokens: 0,
        budget,
        promptChars: prompt.length,
      });
      return;
    }

    const lines: string[] = [];
    const injectedIds: number[] = [];
    let tokens = 0;
    for (const { mem } of scored) {
      const formatted = formatInjection(mem, 220);
      const cost = estimateTokens(formatted);
      if (tokens + cost > budget) break;
      lines.push(formatted);
      injectedIds.push(mem.id);
      tokens += cost;
    }
    if (lines.length === 0) {
      logInjectEvent({
        status: 'skip-empty',
        sessionId,
        project,
        memoryIds: [],
        tokens: 0,
        budget,
        promptChars: prompt.length,
      });
      return;
    }

    process.stdout.write(`${PREAMBLE}\n${lines.join('\n')}\n${POSTAMBLE}\n`);

    logInjectEvent({
      status: 'inject',
      sessionId,
      project,
      memoryIds: injectedIds,
      tokens,
      budget,
      promptChars: prompt.length,
    });

    // Record what we injected so the NEXT prompt in this session doesn't
    // show the same memories again. Write happens after stdout so the user
    // sees context even if the cache file is unwritable.
    if (sessionId) {
      const priorIds = lruStore[sessionId]?.ids ?? [];
      // Prepend new hits, dedup, cap.
      const merged: number[] = [];
      const seen = new Set<number>();
      for (const id of [...injectedIds, ...priorIds]) {
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(id);
        if (merged.length >= LRU_CAP) break;
      }
      lruStore[sessionId] = { ids: merged, at: now };
      writeLru(lruStore);
    }
  } catch {
    // Any DB or SQL error → silent no-op. The user's prompt must never break.
    logInjectEvent({
      status: 'skip-error',
      sessionId,
      project,
      memoryIds: [],
      tokens: 0,
      budget,
      promptChars: prompt.length,
    });
  } finally {
    try {
      db.close();
    } catch {
      /* noop */
    }
  }
}

main();
