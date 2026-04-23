import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'fs';
import { PATHS } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export function getDb(): Database.Database {
  try {
    mkdirSync(PATHS.DB_DIR, { recursive: true, mode: 0o700 });
  } catch (error) {
    logger.error('Failed to create database directory', error as Error);
    throw new Error(
      `Cannot create database directory at ${PATHS.DB_DIR}: ${(error as Error).message}`,
      { cause: error }
    );
  }

  let db: Database.Database;
  try {
    db = new Database(PATHS.DB_FILE);
  } catch (error) {
    logger.error('Failed to open database', error as Error);
    throw new Error(`Cannot open database at ${PATHS.DB_FILE}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  // Set restrictive permissions on database file
  try {
    chmodSync(PATHS.DB_FILE, 0o600);
  } catch {
    // Ignore if permission denied
  }

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    migrateSchema(db);
  } catch (error) {
    logger.error('Failed to initialize database schema', error as Error);
    db.close();
    throw new Error(`Cannot initialize database schema: ${(error as Error).message}`, {
      cause: error,
    });
  }

  return db;
}

function migrateSchema(db: Database.Database): void {
  // v0.2.0: add pinned column
  const cols = db.pragma('table_info(memories)') as { name: string }[];
  if (!cols.some((c) => c.name === 'pinned')) {
    db.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER DEFAULT 0');
  }

  // v0.3.0: knowledge graph — memory_links. Created lazily here as well as in
  // initSchema so existing v0.1/v0.2 databases pick it up on upgrade.
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
  `);

  // v0.4.0: append-only revision history. Captures the PREVIOUS body/tags
  // every time a memory is updated so edits are recoverable.
  db.exec(`
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

function initSchema(db: Database.Database): void {
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

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
      INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
    END;
  `);
}
