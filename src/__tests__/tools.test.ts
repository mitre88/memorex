import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import {
  searchMemories,
  saveMemory,
  pruneMemories,
  getStats,
  getRelated,
  deleteMemory,
} from '../tools/index.js';
import { resetSession, canSave, recordSave } from '../utils/session.js';

const originalEnv = process.env.HOME;

describe('tools', () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memorex-test-'));
    process.env.HOME = tempDir;
    resetSession();

    // Create test DB with schema — includes the pinned column and memory_links
    // table so tests exercise the same surface as production.
    db = new Database(join(tempDir, 'test.db'));
    db.pragma('foreign_keys = ON');
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
        pinned INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, body, tags, content=memories, content_rowid=id);
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
      END;
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
    it('returns compact stats for empty database', () => {
      const result = getStats(db, { format: 'compact' });
      expect(result).toContain('M:0');
      expect(result).toContain('S:');
    });

    it('returns JSON when format=json', () => {
      saveMemory(db, {
        type: 'user',
        title: 'Pref A',
        body: 'body a',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      const result = getStats(db, { format: 'json' });
      const parsed = JSON.parse(result) as {
        total: number;
        by_type: Record<string, number>;
        session: { saves_used: number };
      };
      expect(parsed.total).toBe(1);
      expect(parsed.by_type.user).toBe(1);
      expect(parsed.session).toBeDefined();
    });
  });

  describe('fuzzy dedup', () => {
    it('does NOT merge related-but-distinct titles with different bodies', () => {
      saveMemory(db, {
        type: 'project',
        title: 'Fixed login bug',
        body: 'Issue: cookies cleared on refresh, add sameSite attribute to session',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      const r = saveMemory(db, {
        type: 'project',
        title: 'Fixed logout bug',
        body: 'Redirect loop after signout because middleware kept stale JWT in cache',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      // Two distinct memories — should NOT be merged by word overlap alone.
      expect(r).toContain('Saved memory');
      const rows = db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number };
      expect(rows.n).toBe(2);
    });

    it('merges genuine duplicates with overlapping body', () => {
      saveMemory(db, {
        type: 'project',
        title: 'Deployment pipeline documented',
        body: 'Pipeline uses GitHub Actions with staging then prod steps',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      const r = saveMemory(db, {
        type: 'project',
        title: 'Deployment pipeline documented here',
        body: 'Pipeline uses GitHub Actions with staging then prod steps and cache',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      expect(r).toContain('Updated similar memory');
    });
  });

  describe('memory_links graph', () => {
    it('auto-links new memory to related existing ones', () => {
      saveMemory(db, {
        type: 'project',
        title: 'Auth refactor plan',
        body: 'Rewrite JWT middleware to use httpOnly cookies and short-lived tokens',
        importance: 0.7,
        tags: [],
        pinned: false,
      });
      const r = saveMemory(db, {
        type: 'project',
        title: 'Token rotation implemented',
        body: 'JWT middleware now rotates tokens on every request using cookies',
        importance: 0.7,
        tags: [],
        pinned: false,
      });
      expect(r).toMatch(/\+\d+ link/);
      const links = db.prepare('SELECT COUNT(*) as n FROM memory_links').get() as { n: number };
      // Symmetric: one pair → two rows.
      expect(links.n).toBeGreaterThanOrEqual(2);
    });

    it('getRelated returns neighbors sorted by strength', () => {
      saveMemory(db, {
        type: 'project',
        title: 'Database indexing strategy',
        body: 'Use covering indexes on hot query paths especially user lookups',
        importance: 0.6,
        tags: [],
        pinned: false,
      });
      saveMemory(db, {
        type: 'project',
        title: 'Index on user table',
        body: 'Added covering index for user lookups to speed up hot query paths',
        importance: 0.6,
        tags: [],
        pinned: false,
      });
      const result = getRelated(db, { id: 1, limit: 5, min_strength: 0 });
      expect(result).toContain('neighbor');
    });

    it('cascade-deletes links when memory is deleted', () => {
      saveMemory(db, {
        type: 'project',
        title: 'Observability baseline',
        body: 'Metrics traces logs wired through OpenTelemetry collector',
        importance: 0.6,
        tags: [],
        pinned: false,
      });
      saveMemory(db, {
        type: 'project',
        title: 'OpenTelemetry config',
        body: 'Collector routes metrics traces logs to Prometheus and Loki backends',
        importance: 0.6,
        tags: [],
        pinned: false,
      });
      const before = db.prepare('SELECT COUNT(*) as n FROM memory_links').get() as { n: number };
      expect(before.n).toBeGreaterThan(0);
      deleteMemory(db, { id: 1 });
      const after = db.prepare('SELECT COUNT(*) as n FROM memory_links').get() as { n: number };
      expect(after.n).toBe(0);
    });
  });
});
