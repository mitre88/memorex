import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { searchMemories, saveMemory, pruneMemories, getStats } from '../tools/index.js';
import { resetSession, canSave, recordSave } from '../utils/session.js';

const originalEnv = process.env.HOME;

describe('tools', () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memorex-test-'));
    process.env.HOME = tempDir;
    resetSession();

    // Create test DB with schema
    db = new Database(join(tempDir, 'test.db'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        project TEXT,
        tags TEXT DEFAULT '[]',
        importance REAL DEFAULT 0.5,
        access_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, body, tags, content=memories, content_rowid=id);
    `);
  });

  afterEach(() => {
    process.env.HOME = originalEnv;
    db.close();
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('saveMemory', () => {
    it('saves a new memory', () => {
      const result = saveMemory(db, {
        type: 'user',
        title: 'Test Memory',
        body: 'Test content',
        importance: 0.7,
        tags: [],
        pinned: false,
      });
      expect(result).toContain('Saved memory');
      expect(result).toContain('Test Memory');
    });

    it('updates existing memory with same title+type', () => {
      saveMemory(db, {
        type: 'user',
        title: 'Unique Title Exact',
        body: 'First',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      const result = saveMemory(db, {
        type: 'user',
        title: 'Unique Title Exact',
        body: 'Second',
        importance: 0.6,
        tags: [],
        pinned: false,
      });
      expect(result).toContain('Updated');
    });

    it('respects session limits', () => {
      // This test verifies the limit is enforced by directly testing the flow
      resetSession();
      expect(canSave()).toBe(true); // Fresh session allows saves

      // Simulate hitting the limit
      for (let i = 0; i < 5; i++) {
        recordSave();
      }
      expect(canSave()).toBe(false); // Limit reached
    });
  });

  describe('searchMemories', () => {
    it('returns message when no memories found', () => {
      const result = searchMemories(db, {
        query: 'nonexistent',
        token_budget: 2000,
        min_score: 0.05,
      });
      expect(result).toBe('No relevant memories found.');
    });
  });

  describe('pruneMemories', () => {
    it('reports nothing to prune when empty', () => {
      const result = pruneMemories(db, { dry_run: true, max_age_days: 90 });
      expect(result).toBe('Nothing to prune.');
    });
  });

  describe('getStats', () => {
    it('returns stats for empty database', () => {
      const result = getStats(db, {});
      expect(result).toContain('M:0');
      expect(result).toContain('S:');
    });
  });
});
