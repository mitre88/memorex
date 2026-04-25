#!/usr/bin/env node
/**
 * Stop hook — two jobs:
 *
 *   1. Silent prune of expired and cold-and-low-score memories. This has
 *      been the only Stop behavior since v0.1 and remains unchanged.
 *
 *   2. v0.6.0: synthesize a compact session summary memory from the
 *      transcript. Stores the top user prompts + files touched + duration
 *      as a `project` memory with a 14-day TTL so next session can find
 *      "what we did last time" via plain search. This complements the
 *      PreCompact hook (which covers mid-session compaction) by covering
 *      normal session close.
 *
 * Both paths are fail-silent — Stop must never block.
 */
import { readFileSync } from 'fs';
import { getDb } from '../db/index.js';
import { scoreMemory, type Memory } from '../types/scoring.js';
import { TIME, PRUNE_DEFAULTS, SCORING, LIMITS } from '../utils/config.js';
import { getProjectRoot } from '../utils/project.js';

interface HookPayload {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
}

interface TranscriptEntry {
  type?: string;
  role?: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
  [key: string]: unknown;
}

const SUMMARY_TTL_DAYS = 14;
const SUMMARY_MAX_PROMPTS = 5;
const SUMMARY_MAX_FILES = 10;
const MIN_PROMPTS_TO_SUMMARIZE = 2;

function readStdinSync(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseTranscript(path: string): TranscriptEntry[] {
  try {
    const raw = readFileSync(path, 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as TranscriptEntry;
        } catch {
          return null;
        }
      })
      .filter((x): x is TranscriptEntry => x !== null);
  } catch {
    return [];
  }
}

function extractUserPrompts(entries: TranscriptEntry[]): string[] {
  const prompts: string[] = [];
  for (const e of entries) {
    const role = e.message?.role ?? e.role;
    if (role !== 'user') continue;
    const content = e.message?.content;
    if (typeof content === 'string') {
      const trimmed = content.trim();
      if (trimmed && !trimmed.startsWith('<')) prompts.push(trimmed.slice(0, 160));
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && 'text' in block) {
          const t = (block as { text: unknown }).text;
          if (typeof t === 'string') {
            const trimmed = t.trim();
            if (trimmed && !trimmed.startsWith('<')) prompts.push(trimmed.slice(0, 160));
          }
        }
      }
    }
  }
  return prompts;
}

function extractFilePaths(entries: TranscriptEntry[]): string[] {
  const files = new Set<string>();
  const keys = ['file_path', 'path', 'notebook_path'];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.startsWith('/')) files.add(v);
    }
    for (const v of Object.values(obj)) visit(v);
  };
  for (const e of entries) visit(e);
  return Array.from(files);
}

function sessionDurationMinutes(entries: TranscriptEntry[]): number | null {
  const timestamps = entries
    .map((e) => (typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN))
    .filter((n) => Number.isFinite(n));
  if (timestamps.length < 2) return null;
  timestamps.sort((a, b) => a - b);
  return Math.round((timestamps[timestamps.length - 1] - timestamps[0]) / 60000);
}

function writeSessionSummary(db: ReturnType<typeof getDb>, payload: HookPayload): void {
  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (!transcriptPath) return;
  const entries = parseTranscript(transcriptPath);
  if (entries.length === 0) return;

  const prompts = extractUserPrompts(entries).slice(-SUMMARY_MAX_PROMPTS);
  if (prompts.length < MIN_PROMPTS_TO_SUMMARIZE) return; // too short to be worth summarizing

  const files = extractFilePaths(entries).slice(-SUMMARY_MAX_FILES);
  const duration = sessionDurationMinutes(entries);
  const project = getProjectRoot(typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
  const sessionId =
    typeof payload.session_id === 'string' ? payload.session_id.slice(0, 40) : 'unknown';
  const ts = new Date().toISOString().replace(/T/, ' ').split('.')[0];

  const bodyParts: string[] = [];
  bodyParts.push(`Session ${sessionId} closed ${ts}.`);
  if (duration !== null) bodyParts.push(`Duration: ~${duration} min.`);
  bodyParts.push(`Project: ${project}`);
  bodyParts.push('');
  bodyParts.push('Recent user prompts:');
  for (const p of prompts) bodyParts.push(`  - ${p}`);
  if (files.length > 0) {
    bodyParts.push('');
    bodyParts.push('Files touched:');
    for (const f of files) bodyParts.push(`  - ${f}`);
  }
  let body = bodyParts.join('\n');
  if (body.length > LIMITS.MAX_BODY_LENGTH) {
    body = body.slice(0, LIMITS.MAX_BODY_LENGTH - 3) + '...';
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SUMMARY_TTL_DAYS * TIME.DAY;
  const title = `Session summary: ${ts}`;
  const tags = JSON.stringify(['session-summary', `session-${sessionId}`]);
  try {
    db.prepare(
      `INSERT INTO memories (type, title, body, project, tags, importance, pinned, created_at, accessed_at, expires_at)
       VALUES ('project', ?, ?, ?, ?, 0.45, 0, ?, ?, ?)`
    ).run(title, body, project, tags, now, now, expiresAt);
  } catch {
    // Best-effort — closing must proceed regardless.
  }
}

function pruneColdMemories(db: ReturnType<typeof getDb>): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
  const cutoff = now - PRUNE_DEFAULTS.MAX_AGE_DAYS * TIME.DAY;
  const old = db
    .prepare(
      'SELECT id, type, title, importance, access_count, created_at, accessed_at, expires_at FROM memories WHERE accessed_at < ?'
    )
    .all(cutoff) as Memory[];
  const toDelete = old
    .filter(
      (m) =>
        scoreMemory(m) <
        (SCORING.PRUNE_THRESHOLD[m.type as keyof typeof SCORING.PRUNE_THRESHOLD] ??
          PRUNE_DEFAULTS.COLD_MEMORY_THRESHOLD)
    )
    .map((m) => m.id);
  if (toDelete.length > 0) {
    db.prepare(`DELETE FROM memories WHERE id IN (${toDelete.map(() => '?').join(',')})`).run(
      ...toDelete
    );
  }
}

/**
 * v0.8.0: drop inject_events older than the analytics window.
 * 60 days is enough for `gain --history` 30-day rolling charts plus headroom
 * for users who only run the CLI once a week. Past that the rows are dead
 * weight that bloat the DB on heavy users (~12 KB/day at typical volumes).
 */
function pruneInjectEvents(db: ReturnType<typeof getDb>): void {
  const cutoff = Math.floor(Date.now() / 1000) - 60 * TIME.DAY;
  try {
    db.prepare('DELETE FROM inject_events WHERE ts < ?').run(cutoff);
  } catch {
    /* table may not exist on a partially-migrated DB; silent */
  }
}

function main(): void {
  const raw = readStdinSync();
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    /* no transcript path — just prune */
  }

  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return;
  }
  try {
    writeSessionSummary(db, payload);
    pruneColdMemories(db);
    pruneInjectEvents(db);
  } catch {
    /* never block */
  } finally {
    try {
      db.close();
    } catch {
      /* noop */
    }
  }
}

main();
