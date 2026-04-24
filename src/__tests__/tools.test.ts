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
  updateMemory,
  getHistory,
} from '../tools/index.js';
import { runImport } from '../importers.js';
import { writeFileSync, mkdirSync } from 'fs';
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
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, body, tags, content=memories, content_rowid=id, tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
      END;
      -- Column-restricted update trigger (v0.4.1) — only fires when searchable
      -- content changes, so touching accessed_at / access_count does NOT
      -- re-index FTS. Mirrors the production schema in src/db/index.ts.
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF title, body, tags ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
        INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
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

    it('records a revision on manual update and getHistory surfaces it', () => {
      saveMemory(db, {
        type: 'project',
        title: 'Cache layer design',
        body: 'Initial Redis plan with 1h TTL on warm keys',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      updateMemory(db, { id: 1, body: 'Switched to Memcached after load tests', importance: 0.7 });
      const revs = db.prepare('SELECT * FROM memory_revisions WHERE memory_id = 1').all() as {
        body: string;
        reason: string;
      }[];
      expect(revs.length).toBe(1);
      expect(revs[0].body).toContain('Redis');
      expect(revs[0].reason).toBe('manual-update');

      const history = getHistory(db, { id: 1, limit: 10 });
      expect(history).toContain('revision(s)');
      expect(history).toContain('Redis');
    });

    it('records a revision on upsert (same title)', () => {
      saveMemory(db, {
        type: 'project',
        title: 'Retry policy',
        body: 'Exponential backoff up to 3 attempts',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      saveMemory(db, {
        type: 'project',
        title: 'Retry policy',
        body: 'Use jittered exponential with circuit breaker',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      const revs = db.prepare('SELECT reason FROM memory_revisions WHERE memory_id = 1').all() as {
        reason: string;
      }[];
      expect(revs.length).toBe(1);
      expect(revs[0].reason).toBe('upsert');
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

  describe('importers', () => {
    it('imports a CLAUDE.md by H2 sections', () => {
      const md = [
        '# Project Title',
        '',
        'Intro blurb (skipped — no H2 yet).',
        '',
        '## Environment',
        '',
        'macOS with Apple Silicon and Node 20 LTS pinned via nvmrc.',
        '',
        '## Conventions',
        '',
        'Always use functional style, prefer recursion, prioritize native libs.',
      ].join('\n');
      const path = join(tempDir, 'CLAUDE.md');
      writeFileSync(path, md);
      const result = runImport(db, 'claude-md', path);
      expect(result.imported).toBe(2);
      const rows = db.prepare('SELECT title FROM memories ORDER BY id').all() as {
        title: string;
      }[];
      expect(rows[0].title).toContain('Environment');
      expect(rows[1].title).toContain('Conventions');
    });

    it('imports an obsidian vault recursively', () => {
      const vault = join(tempDir, 'vault');
      const folder = join(vault, 'notes');
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, 'auth.md'),
        'JWT with httpOnly cookies, refresh rotation on every request.'
      );
      writeFileSync(
        join(folder, 'cache.md'),
        'Redis in front of Postgres, warm keys TTL one hour, invalidate on write.'
      );
      const result = runImport(db, 'obsidian', vault);
      expect(result.imported).toBe(2);
      const rows = db.prepare("SELECT tags FROM memories WHERE title = 'auth'").all() as {
        tags: string;
      }[];
      expect(rows[0].tags).toContain('obsidian');
      expect(rows[0].tags).toContain('notes');
    });

    it('imports an engram JSON dump with type mapping', () => {
      const dump = [
        {
          title: 'Switched to PNPM workspaces',
          content: 'Moved from npm to pnpm workspaces for dedup and speed reasons across repos.',
          type: 'decision',
          tags: ['monorepo'],
        },
        {
          title: 'User prefers caveman mode',
          content: 'Terse responses, drop articles and filler, keep technical substance intact.',
          type: 'preference',
          tags: [],
        },
      ];
      const path = join(tempDir, 'engram.json');
      writeFileSync(path, JSON.stringify(dump));
      const result = runImport(db, 'engram', path);
      expect(result.imported).toBe(2);
      const rows = db.prepare('SELECT type FROM memories ORDER BY id').all() as { type: string }[];
      expect(rows[0].type).toBe('project');
      expect(rows[1].type).toBe('user');
    });

    it('dedups on re-import (upsert same title)', () => {
      const md = '## Section A\n\nSome body text worth remembering for the demo.';
      const path = join(tempDir, 'a.md');
      writeFileSync(path, md);
      const first = runImport(db, 'claude-md', path);
      expect(first.imported).toBe(1);
      const second = runImport(db, 'claude-md', path);
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(1);
    });
  });

  describe('v0.4.1 optimizations', () => {
    it('FTS update trigger does NOT fire on accessed_at/access_count updates', () => {
      saveMemory(db, {
        type: 'project',
        title: 'Marker for FTS touch check',
        body: 'sentinelword appears here for assertion matching',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      const before = db
        .prepare(`SELECT count(*) as n FROM memories_fts WHERE memories_fts MATCH 'sentinelword'`)
        .get() as { n: number };
      expect(before.n).toBe(1);

      // Pure metadata update — column-restricted trigger must not fire.
      db.prepare(
        'UPDATE memories SET accessed_at = accessed_at + 1, access_count = access_count + 1 WHERE id = 1'
      ).run();
      const after = db
        .prepare(`SELECT count(*) as n FROM memories_fts WHERE memories_fts MATCH 'sentinelword'`)
        .get() as { n: number };
      expect(after.n).toBe(1);

      // Updating an indexed column (title) DOES re-index so the new title is findable.
      db.prepare('UPDATE memories SET title = ? WHERE id = 1').run('Renamed freshtokenqqq');
      const renamed = db
        .prepare(`SELECT count(*) as n FROM memories_fts WHERE memories_fts MATCH 'freshtokenqqq'`)
        .get() as { n: number };
      expect(renamed.n).toBe(1);
    });

    it('SQL-side eviction removes a low-score non-pinned row, not pinned ones', () => {
      const now = Math.floor(Date.now() / 1000);
      const ancient = now - 60 * 86400; // two months ago
      const insert = db.prepare(
        `INSERT INTO memories (type, title, body, importance, pinned, created_at, accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      // Pinned and high-importance rows should survive.
      insert.run('user', 'Pinned rule', 'core user preference', 0.9, 1, now, now);
      insert.run('project', 'Fresh project note', 'important current work', 0.8, 0, now, now);
      // Low-importance + ancient — should be chosen for eviction.
      insert.run(
        'project',
        'Stale note',
        'old content nobody cares about',
        0.05,
        0,
        ancient,
        ancient
      );

      // Replicate the production eviction SQL (keep in sync with saveMemory).
      db.prepare(
        `DELETE FROM memories WHERE id = (
          SELECT id FROM memories WHERE pinned = 0
          ORDER BY importance * pow(0.5, ((? - accessed_at) / 86400.0) /
            CASE type
              WHEN 'project' THEN 14
              ELSE 60
            END
          ) ASC LIMIT 1
        )`
      ).run(now);

      const remaining = db.prepare('SELECT id, title FROM memories ORDER BY id').all() as {
        id: number;
        title: string;
      }[];
      expect(remaining.length).toBe(2);
      expect(remaining.map((r) => r.title)).not.toContain('Stale note');
      expect(remaining.some((r) => r.title === 'Pinned rule')).toBe(true);
    });

    it('porter stemmer matches morphological variants', () => {
      // With tokenize='porter unicode61' the FTS index stores stems, so
      // "updating" / "updated" / "updates" all match "update".
      saveMemory(db, {
        type: 'project',
        title: 'Deployment pipeline notes',
        body: 'The pipeline is updating frequently after each merge to main.',
        importance: 0.6,
        tags: [],
        pinned: false,
      });
      // Query uses the infinitive — pre-0.5 this would miss.
      const result = searchMemories(db, {
        query: 'update',
        token_budget: 500,
        min_score: 0,
      });
      expect(result).toContain('Deployment pipeline notes');
    });

    it('project hierarchy: memory in /foo matches query for /foo/bar', () => {
      // Simulate a memory saved from the repo root, then a search from a subdir.
      db.prepare(
        `INSERT INTO memories (type, title, body, project) VALUES ('project', 'Repo-wide rule', 'Use tabs for indentation across all packages', '/tmp/repo')`
      ).run();
      const result = searchMemories(db, {
        query: 'indentation tabs',
        project: '/tmp/repo/packages/ui',
        token_budget: 500,
        min_score: 0,
      });
      expect(result).toContain('Repo-wide rule');
    });

    it('project hierarchy: sibling projects do NOT leak into each other', () => {
      db.prepare(
        `INSERT INTO memories (type, title, body, project) VALUES ('project', 'Project A rule', 'Specific to alpha repo', '/tmp/alpha')`
      ).run();
      db.prepare(
        `INSERT INTO memories (type, title, body, project) VALUES ('project', 'Project B rule', 'Specific to beta repo', '/tmp/beta')`
      ).run();
      const result = searchMemories(db, {
        query: 'rule repo',
        project: '/tmp/alpha',
        token_budget: 500,
        min_score: 0,
      });
      expect(result).toContain('Project A rule');
      expect(result).not.toContain('Project B rule');
    });

    it('tag filter: search restricted to requested tags', () => {
      saveMemory(db, {
        type: 'project',
        title: 'Auth decision notes',
        body: 'JWT with rotating refresh tokens chosen for the auth flow.',
        importance: 0.6,
        tags: ['auth', 'decision'],
        pinned: false,
      });
      saveMemory(db, {
        type: 'project',
        title: 'Caching approach selected',
        body: 'Redis chosen for the caching layer backing hot reads.',
        importance: 0.6,
        tags: ['cache', 'decision'],
        pinned: false,
      });
      const onlyAuth = searchMemories(db, {
        query: 'decision',
        tags: ['auth'],
        token_budget: 500,
        min_score: 0,
      });
      expect(onlyAuth).toContain('Auth decision notes');
      expect(onlyAuth).not.toContain('Caching approach selected');
    });

    it('stats aggregate returns correct counts from a single query', () => {
      // Distinct titles + bodies so fuzzy dedup doesn't merge the two project
      // entries. Short titles with overlapping words would trip containment.
      saveMemory(db, {
        type: 'user',
        title: 'User preference alpha',
        body: 'Caveman mode always active across every session',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      saveMemory(db, {
        type: 'project',
        title: 'Queue backpressure design',
        body: 'Backpressure through bounded channels to protect consumers',
        importance: 0.5,
        tags: [],
        pinned: true,
      });
      saveMemory(db, {
        type: 'project',
        title: 'Cache invalidation scheme',
        body: 'Stale-while-revalidate with short TTL and versioned keys',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      const json = getStats(db, { format: 'json' });
      const parsed = JSON.parse(json) as {
        total: number;
        pinned: number;
        by_type: Record<string, number>;
      };
      expect(parsed.total).toBe(3);
      expect(parsed.pinned).toBe(1);
      expect(parsed.by_type.user).toBe(1);
      expect(parsed.by_type.project).toBe(2);
      expect(parsed.by_type.feedback).toBeUndefined();
    });
  });
});
