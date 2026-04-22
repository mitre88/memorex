#!/usr/bin/env node
/**
 * PreCompact hook — snapshot the active session into a memory before the
 * context window gets compacted.
 *
 * Claude Code's compaction throws away in-flight reasoning and tool output,
 * which is exactly what long sessions accumulate. Without this hook, every
 * long session ends with post-compaction amnesia: Claude forgets what it
 * just decided. This hook turns that into a recoverable state by persisting
 * a short project-scoped memory with:
 *
 *   - Files the session touched (Edit/Write tool targets)
 *   - Last N user prompts
 *   - Project root + timestamp
 *
 * The memory has a 7-day TTL so the trail decays naturally. It's tagged
 * `compaction` and `session-<id>` so it's findable but never sticky.
 *
 * Fail-silent: under no circumstance should this hook block compaction.
 */
import { readFileSync } from 'fs';
import { getDb } from '../db/index.js';
import { getProjectRoot } from '../utils/project.js';
import { TIME, LIMITS } from '../utils/config.js';

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  trigger?: string;
}

interface TranscriptEntry {
  type?: string;
  role?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  toolUseResult?: unknown;
  [key: string]: unknown;
}

const MAX_PROMPTS = 5;
const MAX_FILES = 15;
const TTL_DAYS = 7;

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
    // JSONL: one message object per line.
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as TranscriptEntry;
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
      prompts.push(content.slice(0, 200));
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && 'text' in block) {
          const t = (block as { text: unknown }).text;
          if (typeof t === 'string') prompts.push(t.slice(0, 200));
        }
      }
    }
  }
  return prompts.slice(-MAX_PROMPTS);
}

function extractFilePaths(entries: TranscriptEntry[]): string[] {
  const files = new Set<string>();
  const fileKeys = ['file_path', 'path', 'notebook_path'];

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const key of fileKeys) {
      const v = obj[key];
      if (typeof v === 'string' && v.startsWith('/')) {
        files.add(v);
      }
    }
    for (const v of Object.values(obj)) visit(v);
  };

  for (const e of entries) visit(e);
  return Array.from(files).slice(-MAX_FILES);
}

function main(): void {
  const raw = readStdinSync();
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    // Accept empty / non-JSON input — just no-op without transcript.
  }

  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  const entries = transcriptPath ? parseTranscript(transcriptPath) : [];
  const prompts = extractUserPrompts(entries);
  const files = extractFilePaths(entries);
  const project = getProjectRoot(payload.cwd ?? process.cwd());
  const sessionId =
    typeof payload.session_id === 'string' ? payload.session_id.slice(0, 40) : 'unknown';
  const trigger = typeof payload.trigger === 'string' ? payload.trigger : 'auto';
  const ts = new Date().toISOString().replace(/T/, ' ').split('.')[0];

  // Body — capped to respect LIMITS.MAX_BODY_LENGTH.
  const bodyParts: string[] = [];
  bodyParts.push(`Session ${sessionId} compacted at ${ts} (${trigger}).`);
  bodyParts.push(`Project: ${project}`);
  if (prompts.length > 0) {
    bodyParts.push('Recent user prompts:');
    for (const p of prompts) bodyParts.push(`  - ${p}`);
  }
  if (files.length > 0) {
    bodyParts.push('Files touched:');
    for (const f of files) bodyParts.push(`  - ${f}`);
  }
  let body = bodyParts.join('\n');
  if (body.length > LIMITS.MAX_BODY_LENGTH) {
    body = body.slice(0, LIMITS.MAX_BODY_LENGTH - 3) + '...';
  }

  // If there's literally nothing useful to save, skip.
  if (prompts.length === 0 && files.length === 0) return;

  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return;
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + TTL_DAYS * TIME.DAY;
    const title = `Pre-compact snapshot: ${ts}`;
    const tags = JSON.stringify(['compaction', `session-${sessionId}`]);
    // Inserted directly — bypasses session rate limit because compaction is system-driven,
    // not user-driven, and loss here is much worse than over-saving.
    db.prepare(
      `INSERT INTO memories (type, title, body, project, tags, importance, pinned, created_at, accessed_at, expires_at)
       VALUES ('project', ?, ?, ?, ?, 0.6, 0, ?, ?, ?)`
    ).run(title, body, project, tags, now, now, expiresAt);
  } catch {
    // Silent failure — compaction must proceed.
  } finally {
    try {
      db.close();
    } catch {
      /* noop */
    }
  }
}

main();
