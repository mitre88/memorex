#!/usr/bin/env node
/**
 * SubagentStop hook — capture a sub-agent's conclusion into memory.
 *
 * When Claude Code runs an Agent tool call and the sub-agent finishes, it
 * fires SubagentStop with the session's transcript. The final assistant
 * message from the sub-agent is typically the synthesized result the
 * orchestrator will consume. That's the valuable artifact: delegation
 * findings. We persist it as a `feedback` memory with tag `subagent` so
 * future sessions can search across past delegations.
 *
 * Fail-silent and bounded — never blocks the sub-agent loop.
 */
import { readFileSync } from 'fs';
import { getDb } from '../db/index.js';
import { getProjectRoot } from '../utils/project.js';
import { LIMITS, TIME } from '../utils/config.js';

interface HookPayload {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  agent_name?: unknown;
  subagent_type?: unknown;
}

interface TranscriptEntry {
  type?: string;
  role?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  [key: string]: unknown;
}

const TTL_DAYS = 30;

function readStdinSync(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function lastAssistantText(entries: TranscriptEntry[]): string {
  // Walk backward; the most recent assistant message is the synthesized result.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const role = e.message?.role ?? e.role;
    if (role !== 'assistant') continue;
    const content = e.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (block && typeof block === 'object' && 'text' in block) {
          const t = (block as { text: unknown }).text;
          if (typeof t === 'string') parts.push(t);
        }
      }
      if (parts.length > 0) return parts.join('\n');
    }
  }
  return '';
}

function firstUserText(entries: TranscriptEntry[]): string {
  for (const e of entries) {
    const role = e.message?.role ?? e.role;
    if (role !== 'user') continue;
    const content = e.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && 'text' in block) {
          const t = (block as { text: unknown }).text;
          if (typeof t === 'string') return t;
        }
      }
    }
  }
  return '';
}

function parseTranscript(path: string): TranscriptEntry[] {
  try {
    const raw = readFileSync(path, 'utf8');
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

function main(): void {
  const raw = readStdinSync();
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    return;
  }

  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (!transcriptPath) return;

  const entries = parseTranscript(transcriptPath);
  if (entries.length === 0) return;

  const result = lastAssistantText(entries);
  if (!result || result.length < 40) return; // nothing worth saving

  const task = firstUserText(entries).slice(0, 200);
  const agentName =
    (typeof payload.subagent_type === 'string' && payload.subagent_type) ||
    (typeof payload.agent_name === 'string' && payload.agent_name) ||
    'unknown';
  const sessionId =
    typeof payload.session_id === 'string' ? payload.session_id.slice(0, 40) : 'unknown';
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const project = getProjectRoot(cwd);
  const ts = new Date().toISOString().replace(/T/, ' ').split('.')[0];

  // Title format keeps agent + session for easy filter in memory_search.
  const title = `Subagent ${agentName}: ${task.slice(0, 60) || ts}`;
  const bodyParts = [
    `Subagent: ${agentName}`,
    `Session: ${sessionId}`,
    `At: ${ts}`,
    task ? `Task: ${task}` : '',
    '---',
    result,
  ].filter(Boolean);
  let body = bodyParts.join('\n');
  if (body.length > LIMITS.MAX_BODY_LENGTH) {
    body = body.slice(0, LIMITS.MAX_BODY_LENGTH - 3) + '...';
  }

  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return;
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + TTL_DAYS * TIME.DAY;
    const tags = JSON.stringify(['subagent', `agent-${agentName}`, `session-${sessionId}`]);
    // Direct insert — bypasses session rate limit; this is a system-driven capture,
    // not a user-initiated save. Matches the precompact hook's rationale.
    db.prepare(
      `INSERT INTO memories (type, title, body, project, tags, importance, pinned, created_at, accessed_at, expires_at)
       VALUES ('feedback', ?, ?, ?, ?, 0.55, 0, ?, ?, ?)`
    ).run(title, body, project, tags, now, now, expiresAt);
  } catch {
    // Silent failure — sub-agent loop must proceed.
  } finally {
    try {
      db.close();
    } catch {
      /* noop */
    }
  }
}

main();
