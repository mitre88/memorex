import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { runDoctor, doctorExitCode, formatDoctorReport } from '../doctor.js';

/**
 * Doctor tests focus on the report shape and exit-code mapping. We don't try
 * to test the hooks-in-settings.json check end-to-end because that depends
 * on the user's home dir; instead we cover the DB-side checks with a temp DB
 * and verify the WARN path triggers when something is off.
 */
describe('doctor', () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memorex-doctor-'));
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

  it('reports OK on a freshly-initialized DB (modulo hooks check)', () => {
    const r = runDoctor(db);
    // Schema version, integrity, fts.sync, capacity, activity all OK
    const dbChecks = r.results.filter((c) => c.name.startsWith('schema') || c.name === 'integrity' || c.name === 'fts.sync' || c.name === 'capacity' || c.name === 'activity');
    for (const c of dbChecks) {
      expect(c.level).toBe('OK');
    }
    // doctor should at least produce a valid summary
    expect(r.summary.ok + r.summary.warn + r.summary.fail).toBe(r.results.length);
  });

  it('reports fts.sync OK when memories and FTS index are in sync', () => {
    // Insert via the trigger so memories_fts stays consistent.
    db.prepare(`INSERT INTO memories (type, title, body) VALUES ('user', 'a', 'a body')`).run();
    db.prepare(`INSERT INTO memories (type, title, body) VALUES ('user', 'b', 'b body')`).run();
    const r = runDoctor(db);
    const fts = r.results.find((c) => c.name === 'fts.sync');
    expect(fts?.level).toBe('OK');
    expect(fts?.detail).toContain('2 rows');
  });

  it('flags capacity at >=90%', () => {
    // Fill to 91% (181/200) — fast direct inserts skipping triggers/anti-bloat.
    const insert = db.prepare(
      `INSERT INTO memories (type, title, body) VALUES ('user', ?, 'b')`
    );
    db.transaction(() => {
      for (let i = 0; i < 181; i++) insert.run(`row-${i}`);
    })();
    const r = runDoctor(db);
    const cap = r.results.find((c) => c.name === 'capacity');
    expect(cap?.level).toBe('WARN');
    expect(cap?.detail).toMatch(/181/);
  });

  it('exit code 0 on all-OK, 1 on WARN, 2 on FAIL', () => {
    expect(
      doctorExitCode({ results: [], summary: { ok: 5, warn: 0, fail: 0 } })
    ).toBe(0);
    expect(
      doctorExitCode({ results: [], summary: { ok: 4, warn: 1, fail: 0 } })
    ).toBe(1);
    expect(
      doctorExitCode({ results: [], summary: { ok: 4, warn: 0, fail: 1 } })
    ).toBe(2);
    expect(
      doctorExitCode({ results: [], summary: { ok: 4, warn: 1, fail: 1 } })
    ).toBe(2);
  });

  it('renders text report with status tags', () => {
    const text = formatDoctorReport({
      results: [
        { level: 'OK', name: 'foo', detail: 'looks fine' },
        { level: 'WARN', name: 'bar', detail: 'be careful', fix: 'do thing' },
        { level: 'FAIL', name: 'baz', detail: 'broken' },
      ],
      summary: { ok: 1, warn: 1, fail: 1 },
    });
    expect(text).toContain('[OK  ]');
    expect(text).toContain('[WARN]');
    expect(text).toContain('[FAIL]');
    expect(text).toContain('do thing');
    expect(text).toContain('Summary: 1 OK, 1 WARN, 1 FAIL');
  });

  it('runs without a db handle (returns WARN database.open)', () => {
    const r = runDoctor(null);
    const open = r.results.find((c) => c.name === 'database.open');
    expect(open?.level).toBe('WARN');
  });
});
