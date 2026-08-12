/**
 * Shared transcript (JSONL) reader for the Stop / PreCompact / SubagentStop
 * hooks.
 *
 * Why this exists: all three hooks used to `readFileSync` the whole transcript,
 * `split('\n')`, and `JSON.parse` every line into a retained `entries[]` array
 * — then iterate that array two or three more times. PreCompact fires exactly
 * when a session (and therefore its transcript) is largest, so that's the worst
 * possible moment to hold the full file string AND a full array of parsed
 * message objects (object overhead makes the array larger than the source) in a
 * short-lived hook process.
 *
 * `forEachTranscriptEntry` parses one line at a time and hands it to a visitor
 * that extracts only what it needs (a bounded ring of recent prompts, a Set of
 * touched files, min/max timestamps). The parsed entry is released immediately
 * — peak memory drops from O(file) to O(file string + one entry + bounded
 * extracts), roughly halving the spike on long transcripts.
 */
import { readFileSync } from 'fs';

export interface TranscriptEntry {
  type?: string;
  role?: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
  toolUseResult?: unknown;
  [key: string]: unknown;
}

/**
 * Stream a JSONL transcript line-by-line, calling `visit` with each parsed
 * entry. Never builds an array of entries. Returns true if at least one valid
 * entry was seen. Fail-soft: a missing file or a malformed line is skipped.
 */
export function forEachTranscriptEntry(
  path: string,
  visit: (entry: TranscriptEntry) => void
): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return false;
  }

  let sawAny = false;
  let start = 0;
  const len = raw.length;
  // Manual newline scan so we never materialize a `lines[]` array on top of the
  // raw string and a parsed `entries[]` array on top of that.
  for (let i = 0; i <= len; i++) {
    if (i !== len && raw[i] !== '\n') continue;
    if (i > start) {
      const line = raw.slice(start, i).trim();
      if (line) {
        let entry: TranscriptEntry | null = null;
        try {
          entry = JSON.parse(line) as TranscriptEntry;
        } catch {
          entry = null;
        }
        if (entry) {
          sawAny = true;
          visit(entry);
        }
      }
    }
    start = i + 1;
  }
  return sawAny;
}

function entryRole(e: TranscriptEntry): string | undefined {
  return e.message?.role ?? e.role;
}

/** Join the text of a message's content (string passthrough, array → text
 *  blocks joined with newlines). */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && 'text' in block) {
        const t = (block as { text: unknown }).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    return parts.join('\n');
  }
  return '';
}

export interface SessionStats {
  /** Up to `maxPrompts` most-recent user prompts, oldest→newest. */
  prompts: string[];
  /** Up to `maxFiles` distinct touched file paths (absolute), in first-seen order. */
  files: string[];
  /** Earliest / latest parseable entry timestamp (ms epoch), or null. */
  minTs: number | null;
  maxTs: number | null;
}

export interface SessionStatsOptions {
  maxPrompts: number;
  maxFiles: number;
  /** Truncate each captured prompt to this many chars. */
  promptSlice: number;
  /** Drop prompts whose trimmed text starts with '<' (system/wrapper text). */
  skipAngleBracket: boolean;
}

const FILE_KEYS = ['file_path', 'path', 'notebook_path'] as const;

/**
 * Single-pass extraction of the recent prompts, touched files, and time span
 * from a transcript. Returns null if the transcript was empty/unreadable.
 *
 * Bounded memory: prompts are held in a ring of `maxPrompts`; files in a Set of
 * distinct paths (count is naturally small — paths touched in one session); no
 * timestamp array is retained.
 */
export function collectSessionStats(path: string, opts: SessionStatsOptions): SessionStats | null {
  const prompts: string[] = [];
  const files = new Set<string>();
  let minTs: number | null = null;
  let maxTs: number | null = null;

  const visitForFiles = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visitForFiles(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const k of FILE_KEYS) {
      const v = obj[k];
      if (typeof v === 'string' && v.startsWith('/')) files.add(v);
    }
    for (const v of Object.values(obj)) visitForFiles(v);
  };

  const pushPrompt = (s: string): void => {
    const trimmed = s.trim();
    if (!trimmed) return;
    if (opts.skipAngleBracket && trimmed.startsWith('<')) return;
    prompts.push(trimmed.slice(0, opts.promptSlice));
    if (prompts.length > opts.maxPrompts) prompts.shift();
  };

  const sawAny = forEachTranscriptEntry(path, (e) => {
    if (typeof e.timestamp === 'string') {
      const t = Date.parse(e.timestamp);
      if (Number.isFinite(t)) {
        if (minTs === null || t < minTs) minTs = t;
        if (maxTs === null || t > maxTs) maxTs = t;
      }
    }

    if (entryRole(e) === 'user') {
      const content = e.message?.content;
      if (typeof content === 'string') {
        pushPrompt(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && 'text' in block) {
            const t = (block as { text: unknown }).text;
            if (typeof t === 'string') pushPrompt(t);
          }
        }
      }
    }

    visitForFiles(e);
  });

  if (!sawAny) return null;
  return { prompts, files: Array.from(files).slice(-opts.maxFiles), minTs, maxTs };
}

/**
 * For SubagentStop: the first user message (the delegated task) and the last
 * assistant message (the synthesized result), in one pass. Returns null if the
 * transcript was empty/unreadable.
 */
export function collectFirstUserLastAssistant(
  path: string
): { firstUser: string; lastAssistant: string } | null {
  let firstUser = '';
  let firstUserSet = false;
  let lastAssistant = '';

  const sawAny = forEachTranscriptEntry(path, (e) => {
    const role = entryRole(e);
    if (role === 'user' && !firstUserSet) {
      firstUser = contentToText(e.message?.content ?? e.message);
      firstUserSet = true;
    } else if (role === 'assistant') {
      const text = contentToText(e.message?.content);
      if (text) lastAssistant = text;
    }
  });

  if (!sawAny) return null;
  return { firstUser, lastAssistant };
}
