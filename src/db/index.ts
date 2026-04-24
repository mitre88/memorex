import Database from 'better-sqlite3';
import { mkdirSync, chmodSync, existsSync } from 'fs';
import { dirname } from 'path';
import { PATHS } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export interface OpenOptions {
  /** Override the DB file path — used by tests. Defaults to PATHS.DB_FILE. */
  path?: string;
}

/**
 * Schema version written via `PRAGMA user_version`. Bump when you change any
 * CREATE TABLE / CREATE TRIGGER / CREATE INDEX statement below. The migration
 * gate in getDb() skips all DDL work when the on-disk version already matches.
 *
 * Why this matters: hooks spawn 4 short-lived Node processes per session and
 * each one used to re-parse 3 triggers + 4 CREATE TABLE IF NOT EXISTS + a
 * virtual FTS5 table on every boot. Parsing DDL isn't free even when the
 * tables already exist; the version gate makes re-opens O(1).
 */
const SCHEMA_VERSION = 4;

export function getDb(opts: OpenOptions = {}): Database.Database {
  const dbFile = opts.path ?? PATHS.DB_FILE;
  const dbDir = opts.path ? dirname(opts.path) : PATHS.DB_DIR;
  try {
    mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    logger.error('Failed to create database directory', error as Error);
    throw new Error(`Cannot create database directory at ${dbDir}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  let db: Database.Database;
  try {
    db = new Database(dbFile);
  } catch (error) {
    logger.error('Failed to open database', error as Error);
    throw new Error(`Cannot open database at ${dbFile}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  // Set restrictive permissions on database file
  try {
    chmodSync(dbFile, 0o600);
  } catch {
    // Ignore if permission denied
  }

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    applySchema(db);
  } catch (error) {
    logger.error('Failed to initialize database schema', error as Error);
    db.close();
    throw new Error(`Cannot initialize database schema: ${(error as Error).message}`, {
      cause: error,
    });
  }

  return db;
}

/**
 * Open the database in read-only mode. Used by the UserPromptSubmit hook
 * because auto-injection is a pure read path:
 *
 *   - No chmod, no journal_mode WAL setup, no DDL parsing.
 *   - SQLite opens in a leaner mode (no write journal allocated).
 *   - Throws cleanly if the DB file doesn't exist yet — fresh installs with
 *     no memories still can't inject anything, so aborting is correct.
 *
 * Falls back to `null` when the DB is missing so callers can early-exit
 * without try/catch ceremony.
 */
export function getDbReadonly(opts: OpenOptions = {}): Database.Database | null {
  const dbFile = opts.path ?? PATHS.DB_FILE;
  if (!existsSync(dbFile)) return null;
  try {
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    return db;
  } catch {
    return null;
  }
}

function applySchema(db: Database.Database): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (current >= SCHEMA_VERSION) return;

  // Run all migrations in a single transaction so a partial upgrade never
  // leaves the DB in an in-between state.
  const migrate = db.transaction(() => {
    if (current < 1) initV1(db);
    if (current < 2) migrateV2(db);
    if (current < 3) migrateV3(db);
    if (current < 4) migrateV4(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  migrate();
}

function initV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL CHECK(type IN ('user','project','feedback','reference')),
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      project     TEXT,
      tags        TEXT DEFAULT '[]',
      importance  REAL DEFAULT 0.5,
      access_count INTEGER DEFAULT 0,
      pinned      INTEGER DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at  INTEGER
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      title,
      body,
      tags,
      content=memories,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
    END;
  `);
}

function migrateV2(db: Database.Database): void {
  // Pre-0.2 schema had no pinned column. Add it if missing.
  const cols = db.pragma('table_info(memories)') as { name: string }[];
  if (!cols.some((c) => c.name === 'pinned')) {
    db.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER DEFAULT 0');
  }
}

function migrateV3(db: Database.Database): void {
  // Knowledge graph and revision history (from v0.3 / v0.4 chronologically,
  // consolidated into one version here because neither shipped to users with
  // a user_version gate — the "run once, idempotent" behavior is preserved).
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_links (
      source_id   INTEGER NOT NULL,
      target_id   INTEGER NOT NULL,
      strength    REAL NOT NULL DEFAULT 0.5,
      kind        TEXT NOT NULL DEFAULT 'related'
                    CHECK(kind IN ('related','supersedes','references')),
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (source_id, target_id, kind),
      FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_id);
    CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_id);

    CREATE TABLE IF NOT EXISTS memory_revisions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id    INTEGER NOT NULL,
      body         TEXT NOT NULL,
      tags         TEXT NOT NULL DEFAULT '[]',
      importance   REAL NOT NULL DEFAULT 0.5,
      revised_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      reason       TEXT,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory ON memory_revisions(memory_id);
  `);
}

function migrateV4(db: Database.Database): void {
  // v0.4.1: restrict the FTS update trigger so it only reindexes when
  // searchable content actually changes. Previously the trigger fired on
  // ANY UPDATE, so refreshing accessed_at / access_count on a search hit
  // caused a full FTS5 delete+insert for that row. Measurable: a search
  // returning 3 hits used to trigger 3 FTS reindexes per search.
  //
  // Also add a partial index on the hot recency path to speed up context /
  // prune queries that scan by (pinned, accessed_at).
  db.exec(`
    DROP TRIGGER IF EXISTS memories_au;
    CREATE TRIGGER memories_au AFTER UPDATE OF title, body, tags ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
      INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
    END;

    CREATE INDEX IF NOT EXISTS idx_memories_recency ON memories(pinned, accessed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_type_title ON memories(type, title);
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project) WHERE project IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
  `);
}
