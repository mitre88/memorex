import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getDb, getDbReadonly } from '../db/index.js';

/**
 * These tests exercise the real getDb / getDbReadonly code paths by pointing
 * them at a temp database via the `path` override. We deliberately do NOT
 * mutate process.env.HOME here because PATHS is resolved at module load time
 * — HOME mutation after import has no effect.
 */
describe('db initialization', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memorex-db-'));
    dbPath = join(tempDir, 'test.db');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('getDbReadonly returns null when DB file does not yet exist', () => {
    const db = getDbReadonly({ path: dbPath });
    expect(db).toBeNull();
  });

  it('getDb creates and migrates; user_version reflects SCHEMA_VERSION', () => {
    const db = getDb({ path: dbPath });
    const v = db.pragma('user_version', { simple: true }) as number;
    expect(v).toBeGreaterThanOrEqual(4);

    // All production tables exist.
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memory_links','memory_revisions','memories')`
      )
      .all() as { name: string }[];
    expect(tables.length).toBe(3);
    db.close();
  });

  it('second getDb open is a no-op for DDL (schema version gate)', () => {
    const a = getDb({ path: dbPath });
    const v1 = a.pragma('user_version', { simple: true }) as number;
    a.close();

    const b = getDb({ path: dbPath });
    const v2 = b.pragma('user_version', { simple: true }) as number;
    expect(v2).toBe(v1);
    b.close();
  });

  it('getDbReadonly opens cleanly after getDb has created the file', () => {
    const w = getDb({ path: dbPath });
    w.prepare(
      `INSERT INTO memories (type, title, body) VALUES ('user', 'seed', 'seed body')`
    ).run();
    w.close();

    const r = getDbReadonly({ path: dbPath });
    expect(r).not.toBeNull();
    const rows = r!.prepare('SELECT title FROM memories').all() as { title: string }[];
    expect(rows[0].title).toBe('seed');

    // Writes MUST fail on a readonly handle.
    expect(() =>
      r!.prepare(`INSERT INTO memories (type, title, body) VALUES ('user', 'x', 'y')`).run()
    ).toThrow();
    r!.close();
  });

  it('update trigger is column-restricted (UPDATE OF title, body, tags)', () => {
    const db = getDb({ path: dbPath });
    const trig = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='memories_au'`)
      .get() as { sql: string } | undefined;
    expect(trig).toBeDefined();
    expect(trig!.sql).toMatch(/UPDATE OF\s+title\s*,\s*body\s*,\s*tags/i);
    db.close();
  });

  it('creates the parent directory when path is under a fresh tempdir', () => {
    const nested = join(tempDir, 'nested', 'deeper', 'memorex.db');
    const db = getDb({ path: nested });
    expect(existsSync(nested)).toBe(true);
    db.close();
  });

  it('migration v7 creates inject_events table with expected schema', () => {
    const db = getDb({ path: dbPath });
    const v = db.pragma('user_version', { simple: true }) as number;
    expect(v).toBeGreaterThanOrEqual(7);

    const t = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='inject_events'`
      )
      .get();
    expect(t).toBeDefined();

    const cols = db.pragma('table_info(inject_events)') as { name: string }[];
    const colNames = cols.map((c) => c.name).sort();
    expect(colNames).toEqual(
      ['budget', 'id', 'memory_ids', 'project', 'prompt_chars', 'session_id', 'status', 'tokens', 'ts']
    );

    // CHECK constraint enforces status enum
    expect(() =>
      db
        .prepare(
          `INSERT INTO inject_events (status, memory_ids) VALUES ('garbage', '[]')`
        )
        .run()
    ).toThrow();
    db.close();
  });

  it('migration v8 adds embedding column and partial index to memories', () => {
    const db = getDb({ path: dbPath });
    const v = db.pragma('user_version', { simple: true }) as number;
    expect(v).toBeGreaterThanOrEqual(8);

    const cols = db.pragma('table_info(memories)') as { name: string; type: string }[];
    const emb = cols.find((c) => c.name === 'embedding');
    expect(emb).toBeDefined();
    expect(emb!.type).toBe('BLOB');

    // Partial index exists
    const idx = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_memories_embedding'`
      )
      .get() as { sql: string } | undefined;
    expect(idx).toBeDefined();
    expect(idx!.sql).toMatch(/WHERE\s+embedding\s+IS\s+NOT\s+NULL/i);
    db.close();
  });
});
