import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { getDb } from '../db/index.js';
import {
  getGainSummary,
  getGainHistory,
  formatGainSummary,
  formatGainHistory,
} from '../analytics.js';

/**
 * Analytics tests against a temp DB. We seed inject_events directly rather
 * than going through the hook so we control timestamps and statuses.
 */
describe('analytics — memorex gain', () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memorex-gain-'));
    dbPath = join(tempDir, 't.db');
    db = getDb({ path: dbPath });
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  function insertEvent(
    status: string,
    memoryIds: number[],
    tokens: number,
    budget: number,
    sessionId: string | null,
    tsOffsetSec: number
  ): void {
    const ts = Math.floor(Date.now() / 1000) + tsOffsetSec;
    db.prepare(
      `INSERT INTO inject_events
         (ts, session_id, project, memory_ids, tokens, budget, prompt_chars, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(ts, sessionId, '/repo', JSON.stringify(memoryIds), tokens, budget, 100, status);
  }

  it('summary aggregates statuses and tokens correctly', () => {
    insertEvent('inject', [1, 2], 200, 500, 'sess-a', -3600);
    insertEvent('inject', [1, 3], 300, 500, 'sess-a', -1800);
    insertEvent('skip-empty', [], 0, 500, 'sess-a', -900);
    insertEvent('skip-dedup', [], 0, 500, 'sess-b', -300);

    const s = getGainSummary(db, { days: 7 });
    expect(s.total_prompts).toBe(4);
    expect(s.injects).toBe(2);
    expect(s.skips.empty).toBe(1);
    expect(s.skips.dedup).toBe(1);
    expect(s.tokens_total).toBe(500);
    expect(s.tokens_avg).toBe(250);
    expect(s.inject_rate).toBeCloseTo(0.5, 5);
  });

  it('top_memories surfaces the most-shown ids in order', () => {
    insertEvent('inject', [42, 1], 100, 500, 's', -100);
    insertEvent('inject', [42, 7], 100, 500, 's', -50);
    insertEvent('inject', [42, 1], 100, 500, 's', -10);

    const s = getGainSummary(db, { days: 7 });
    expect(s.top_memories[0].id).toBe(42);
    expect(s.top_memories[0].count).toBe(3);
    const id1 = s.top_memories.find((m) => m.id === 1);
    expect(id1?.count).toBe(2);
  });

  it('budget_hits counts saturated injects', () => {
    insertEvent('inject', [1], 500, 500, 's', -100); // saturated
    insertEvent('inject', [2], 250, 500, 's', -50); // not saturated
    insertEvent('inject', [3], 600, 500, 's', -10); // over budget — counts

    const s = getGainSummary(db, { days: 7 });
    expect(s.budget_hits).toBe(2);
  });

  it('respects the days window (excludes old rows)', () => {
    insertEvent('inject', [1], 100, 500, 's', -100);
    insertEvent('inject', [2], 100, 500, 's', -86400 * 30); // 30 days ago
    const s7 = getGainSummary(db, { days: 7 });
    expect(s7.total_prompts).toBe(1);
    const s60 = getGainSummary(db, { days: 60 });
    expect(s60.total_prompts).toBe(2);
  });

  it('respects the project filter', () => {
    db.prepare(
      `INSERT INTO inject_events (ts, project, memory_ids, status, tokens, budget)
       VALUES (?, '/other', '[1]', 'inject', 100, 500)`
    ).run(Math.floor(Date.now() / 1000) - 10);
    insertEvent('inject', [1], 200, 500, 's', -100);
    const s = getGainSummary(db, { days: 7, project: '/repo' });
    expect(s.total_prompts).toBe(1);
    expect(s.tokens_total).toBe(200);
  });

  it('hit_ratio_estimate detects same-session re-use within 30 min', () => {
    // sess-a: id 1 shown, then re-used within 30 min → hit
    insertEvent('inject', [1, 2], 100, 500, 'sess-a', -1500);
    insertEvent('inject', [1, 7], 100, 500, 'sess-a', -1200);
    // sess-b: id 9 shown, never re-used → miss
    insertEvent('inject', [9], 100, 500, 'sess-b', -800);
    const s = getGainSummary(db, { days: 7 });
    // 3 inject events: first hits via second, second has nothing after, third has nothing
    // => hits=1, denom=3, ratio = 0.333
    expect(s.hit_ratio_estimate).toBeGreaterThan(0);
    expect(s.hit_ratio_estimate).toBeLessThan(0.5);
  });

  it('history buckets events by day', () => {
    insertEvent('inject', [1], 100, 500, 's', 0);
    insertEvent('inject', [2], 200, 500, 's', -10);
    const rows = getGainHistory(db, { days: 7 });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const today = rows[rows.length - 1];
    expect(today.injects).toBeGreaterThanOrEqual(2);
    expect(today.tokens).toBeGreaterThanOrEqual(300);
  });

  it('formatters produce non-empty strings even with empty data', () => {
    const s = getGainSummary(db, { days: 7 });
    expect(formatGainSummary(s)).toContain('No inject events recorded');
    expect(formatGainHistory([])).toContain('No history');
  });
});
