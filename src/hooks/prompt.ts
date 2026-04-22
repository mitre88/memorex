#!/usr/bin/env node
/**
 * UserPromptSubmit hook — auto-inject relevant memories into every prompt.
 *
 * This is the hook that turns memorex from "tool Claude must remember to call"
 * into "passive memory layer always on". On every user prompt:
 *
 *   1. Read the incoming prompt from Claude Code's hook stdin JSON.
 *   2. Run a budget-capped FTS search against memories scoped to this project.
 *   3. Emit top matches on stdout — Claude Code appends them to the prompt as
 *      additional context.
 *
 * Guarantees:
 *   - Never blocks the user: every failure exits silently with code 0.
 *   - Zero-cost when there are no relevant memories (prints nothing).
 *   - Does NOT refresh accessed_at on matches — auto-injection shouldn't
 *     artificially extend the life of otherwise-cold memories.
 *   - Self-budgeted to ~500 tokens; tunable via MEMOREX_INJECT_BUDGET env.
 */
import { readFileSync } from 'fs';
import { getDb } from '../db/index.js';
import {
  scoreMemory,
  estimateTokens,
  formatMemoryForContext,
  type Memory,
} from '../types/scoring.js';
import { SCORING, SEARCH_DEFAULTS } from '../utils/config.js';
import { getProjectRoot } from '../utils/project.js';
import { sanitizeFtsQuery } from '../utils/security.js';

const INJECT_TOKEN_BUDGET = Number(process.env.MEMOREX_INJECT_BUDGET ?? '500');
const INJECT_MIN_SCORE = Number(process.env.MEMOREX_INJECT_MIN_SCORE ?? '0.15');
const INJECT_MAX_RESULTS = Number(process.env.MEMOREX_INJECT_MAX ?? '3');
// Inject preamble must be unambiguous so Claude treats this as memory, not user text.
const PREAMBLE = '<memorex-context source="memorex" scope="auto-injected">';
const POSTAMBLE = '</memorex-context>';

function readStdinSync(): string {
  try {
    // `0` is the stdin file descriptor. readFileSync handles closed pipes cleanly.
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

function extractPrompt(raw: string): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as HookPayload;
    if (typeof parsed.prompt === 'string') return parsed.prompt;
  } catch {
    // Not JSON — some hook harnesses pipe raw text. Use as-is.
    return raw;
  }
  return '';
}

function main(): void {
  const raw = readStdinSync();
  const prompt = extractPrompt(raw).slice(0, 2000); // cap to avoid FTS DoS
  if (!prompt.trim()) return;

  const safe = sanitizeFtsQuery(prompt);
  if (!safe || safe === '*') return;

  const project = getProjectRoot();
  const now = Math.floor(Date.now() / 1000);

  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return;
  }

  try {
    const { title: wt, body: wb, tags: wtags } = SCORING.BM25_WEIGHTS;
    const rows = db
      .prepare(
        `
      SELECT m.*, bm25(memories_fts, ${wt}, ${wb}, ${wtags}) as fts_rank
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ?
        AND (m.project IS NULL OR m.project = ?)
        AND (m.expires_at IS NULL OR m.expires_at > ?)
      ORDER BY fts_rank
      LIMIT ?
    `
      )
      .all(safe, project, now, SEARCH_DEFAULTS.RESULT_LIMIT) as (Memory & {
      fts_rank: number;
    })[];

    if (rows.length === 0) return;

    const scored = rows
      .map((r) => ({ mem: r, score: scoreMemory(r, r.fts_rank) }))
      .filter((x) => x.score >= INJECT_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, INJECT_MAX_RESULTS);

    if (scored.length === 0) return;

    const lines: string[] = [];
    let tokens = 0;
    for (const { mem } of scored) {
      // Use tighter display cap for injection so we don't hog the budget on one row.
      const formatted = formatMemoryForContext(mem, 220);
      const cost = estimateTokens(formatted);
      if (tokens + cost > INJECT_TOKEN_BUDGET) break;
      lines.push(formatted);
      tokens += cost;
    }
    if (lines.length === 0) return;

    process.stdout.write(`${PREAMBLE}\n${lines.join('\n')}\n${POSTAMBLE}\n`);
  } catch {
    // Any DB or SQL error → silent no-op. The user's prompt must never break.
  } finally {
    try {
      db.close();
    } catch {
      /* noop */
    }
  }
}

main();
