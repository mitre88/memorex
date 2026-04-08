import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, chmodSync } from 'fs';

const DB_DIR = join(homedir(), '.memorex');
const DB_PATH = join(DB_DIR, 'memories.db');

export function getDb(): Database.Database {
  mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
  const db = new Database(DB_PATH);
  // Set restrictive permissions on database file
  try {
    chmodSync(DB_PATH, 0o600);
  } catch {
    // Ignore if permission denied
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
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
