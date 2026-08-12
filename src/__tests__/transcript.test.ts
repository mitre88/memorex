import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  forEachTranscriptEntry,
  collectSessionStats,
  collectFirstUserLastAssistant,
} from '../utils/transcript.js';

let dir: string;
let file: string;

function writeJsonl(lines: unknown[]): void {
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memorex-transcript-'));
  file = join(dir, 'transcript.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('transcript streaming', () => {
  it('forEachTranscriptEntry skips malformed lines and reports sawAny', () => {
    writeFileSync(file, ['{"role":"user"}', 'not json', '', '{"role":"assistant"}'].join('\n'));
    const seen: string[] = [];
    const sawAny = forEachTranscriptEntry(file, (e) => {
      if (typeof e.role === 'string') seen.push(e.role);
    });
    expect(sawAny).toBe(true);
    expect(seen).toEqual(['user', 'assistant']);
  });

  it('forEachTranscriptEntry returns false on a missing file', () => {
    const sawAny = forEachTranscriptEntry(join(dir, 'nope.jsonl'), () => {
      throw new Error('should not be called');
    });
    expect(sawAny).toBe(false);
  });

  it('collectSessionStats keeps only the last N prompts and dedups files', () => {
    writeJsonl([
      { message: { role: 'user', content: 'first' }, timestamp: '2026-01-01T00:00:00.000Z' },
      {
        message: { role: 'assistant', content: 'work' },
        toolUseResult: { file_path: '/a/x.ts' },
      },
      { message: { role: 'user', content: 'second' } },
      { message: { role: 'user', content: 'third' }, timestamp: '2026-01-01T00:10:00.000Z' },
      { message: { role: 'user', content: [{ type: 'text', text: '/a/x.ts again referenced' }] } },
      { type: 'tool', file_path: '/a/x.ts', path: '/b/y.ts' },
    ]);
    const stats = collectSessionStats(file, {
      maxPrompts: 2,
      maxFiles: 10,
      promptSlice: 100,
      skipAngleBracket: true,
    });
    expect(stats).not.toBeNull();
    expect(stats!.prompts).toEqual(['third', '/a/x.ts again referenced']); // last 2 only
    expect(stats!.files.sort()).toEqual(['/a/x.ts', '/b/y.ts']); // deduped
    expect(stats!.minTs).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(stats!.maxTs).toBe(Date.parse('2026-01-01T00:10:00.000Z'));
  });

  it('collectSessionStats honors skipAngleBracket and trims', () => {
    writeJsonl([
      { message: { role: 'user', content: '  <system reminder>  ' } },
      { message: { role: 'user', content: '   ' } },
      { message: { role: 'user', content: '  real prompt  ' } },
    ]);
    const skip = collectSessionStats(file, {
      maxPrompts: 5,
      maxFiles: 5,
      promptSlice: 100,
      skipAngleBracket: true,
    });
    expect(skip!.prompts).toEqual(['real prompt']);

    const keep = collectSessionStats(file, {
      maxPrompts: 5,
      maxFiles: 5,
      promptSlice: 100,
      skipAngleBracket: false,
    });
    expect(keep!.prompts).toEqual(['<system reminder>', 'real prompt']);
  });

  it('collectSessionStats returns null on empty/unreadable transcript', () => {
    expect(
      collectSessionStats(join(dir, 'missing.jsonl'), {
        maxPrompts: 5,
        maxFiles: 5,
        promptSlice: 100,
        skipAngleBracket: true,
      })
    ).toBeNull();
  });

  it('collectFirstUserLastAssistant grabs the task and the result', () => {
    writeJsonl([
      { message: { role: 'user', content: 'do the thing' } },
      { message: { role: 'assistant', content: 'thinking' } },
      { message: { role: 'user', content: 'follow up' } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'final result' }] } },
    ]);
    const texts = collectFirstUserLastAssistant(file);
    expect(texts).not.toBeNull();
    expect(texts!.firstUser).toBe('do the thing');
    expect(texts!.lastAssistant).toBe('final result');
  });

  it('collectFirstUserLastAssistant returns null when there are no entries', () => {
    expect(collectFirstUserLastAssistant(join(dir, 'missing.jsonl'))).toBeNull();
  });
});
