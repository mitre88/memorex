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
  mergeMemories,
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
        last_used_at INTEGER,
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

    it('search dedup collapses near-duplicate bodies with a similarity tail', () => {
      // Two memories covering the same topic with overlapping vocabulary.
      saveMemory(db, {
        type: 'project',
        title: 'Logging framework choice alpha',
        body: 'Structured logging using pino chosen for production services across the backend platform.',
        importance: 0.7,
        tags: [],
        pinned: false,
      });
      saveMemory(db, {
        type: 'project',
        title: 'Logging framework choice beta',
        body: 'Structured logging chosen using pino for backend production services across the platform.',
        importance: 0.6,
        tags: [],
        pinned: false,
      });
      const result = searchMemories(db, {
        query: 'logging pino structured backend',
        token_budget: 2000,
        min_score: 0,
      });
      // Only the higher-scoring keeper should render as a full entry; the dup
      // should show up only as a "+1 similar" tail.
      const lines = result.split('\n').filter((l) => l.includes('Logging framework'));
      expect(lines.length).toBe(1);
      expect(result).toMatch(/\+1 similar/);
    });

    it('TTL auto-promotion clears expires_at after threshold accesses', () => {
      // Seed a memory with a near-expiry TTL and 4 accesses already. One more
      // search hit should bump it over PROMOTION_MIN_ACCESSES (5) and clear
      // expires_at because it's still within the 7-day creation window.
      const now = Math.floor(Date.now() / 1000);
      const soon = now + 60 * 60; // expires in 1 hour
      db.prepare(
        `INSERT INTO memories (type, title, body, importance, access_count, created_at, accessed_at, expires_at)
         VALUES ('project', 'Promotable note', 'Frequently reused project fact about the build pipeline', 0.5, 4, ?, ?, ?)`
      ).run(now - 1000, now - 7200, soon);

      // Trigger a search that hits this row. Query matches body words.
      // Accessed_at was 2h ago, older than ACCESS_COOLDOWN, so the bump fires.
      searchMemories(db, {
        query: 'build pipeline project fact',
        token_budget: 2000,
        min_score: 0,
      });
      const after = db
        .prepare('SELECT expires_at, access_count FROM memories WHERE id = 1')
        .get() as {
        expires_at: number | null;
        access_count: number;
      };
      expect(after.access_count).toBe(5);
      expect(after.expires_at).toBeNull();
    });

    it('memory_merge concatenates bodies, unions tags, deletes merge_id', () => {
      saveMemory(db, {
        type: 'project',
        title: 'Deploy pipeline notes',
        body: 'Uses GitHub Actions with staging then prod steps.',
        importance: 0.6,
        tags: ['ci', 'deploy'],
        pinned: false,
      });
      saveMemory(db, {
        type: 'project',
        title: 'Deploy pipeline addendum',
        body: 'Also uses cache restoration for faster builds.',
        importance: 0.7,
        tags: ['cache'],
        pinned: false,
      });
      const result = mergeMemories(db, {
        keep_id: 1,
        merge_id: 2,
        separator: '\n---\n',
      });
      expect(result).toMatch(/Merged #2/);
      const kept = db.prepare('SELECT body, tags, importance FROM memories WHERE id = 1').get() as {
        body: string;
        tags: string;
        importance: number;
      };
      expect(kept.body).toContain('staging');
      expect(kept.body).toContain('cache restoration');
      expect(kept.importance).toBe(0.7);
      const tags = JSON.parse(kept.tags) as string[];
      expect(tags).toEqual(expect.arrayContaining(['ci', 'deploy', 'cache']));
      // merge_id is gone.
      const gone = db.prepare('SELECT id FROM memories WHERE id = 2').get();
      expect(gone).toBeUndefined();
      // Revision captured before merge.
      const revs = db.prepare('SELECT reason FROM memory_revisions WHERE memory_id = 1').all() as {
        reason: string;
      }[];
      expect(revs.some((r) => r.reason === 'merge')).toBe(true);
    });

    it('memory_merge rejects same id for keep and merge', () => {
      saveMemory(db, {
        type: 'project',
        title: 'Some note',
        body: 'Some body text for the note regarding topics of interest.',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      const result = mergeMemories(db, { keep_id: 1, merge_id: 1, separator: '\n' });
      expect(result).toMatch(/differ/);
    });

    it('M4 — revisions compaction: keeps only 10 most recent, deletes older', () => {
      saveMemory(db, {
        type: 'feedback',
        title: 'Revision compaction target',
        body: 'Initial body for the compaction test memory entry.',
        importance: 0.5,
        tags: [],
        pinned: false,
      });
      const id = (db.prepare('SELECT id FROM memories LIMIT 1').get() as { id: number }).id;
      // Force 12 update cycles — each triggers recordRevision → we should only
      // retain the 10 most recent afterwards.
      for (let i = 0; i < 12; i++) {
        updateMemory(db, { id, body: `Updated body iteration ${i} with extra detail.` });
      }
      const count = (
        db.prepare('SELECT COUNT(*) as n FROM memory_revisions WHERE memory_id = ?').get(id) as {
          n: number;
        }
      ).n;
      expect(count).toBeLessThanOrEqual(10);
    });

    it('M3 — link decay: getRelated refreshes last_used_at on traversal', () => {
      // Save two linked memories so autoLinkMemory creates a link pair.
      saveMemory(db, {
        type: 'project',
        title: 'Redis caching strategy documentation',
        body: 'Redis chosen for hot-read caching; TTL 60s. Invalidate on write via pub/sub.',
        importance: 0.7,
        tags: ['cache'],
        pinned: false,
      });
      saveMemory(db, {
        type: 'project',
        title: 'Redis eviction policy selection notes',
        body: 'Using allkeys-lru eviction policy for Redis to handle memory pressure.',
        importance: 0.6,
        tags: ['cache'],
        pinned: false,
      });
      // autoLinkMemory creates (1→2) and (2→1) links. Backdate last_used_at
      // on the (1→2) link to simulate a stale connection.
      const past = Math.floor(Date.now() / 1000) - 10 * 86400; // 10 days ago
      db.prepare(
        'UPDATE memory_links SET last_used_at = ? WHERE source_id = 1 AND target_id = 2'
      ).run(past);

      const before = db
        .prepare('SELECT last_used_at FROM memory_links WHERE source_id = 1 AND target_id = 2')
        .get() as { last_used_at: number };
      expect(before.last_used_at).toBe(past);

      getRelated(db, { id: 1, limit: 5, min_strength: 0 });

      const after = db
        .prepare('SELECT last_used_at FROM memory_links WHERE source_id = 1 AND target_id = 2')
        .get() as { last_used_at: number };
      // Traversal should have bumped last_used_at to approximately now.
      expect(after.last_used_at).toBeGreaterThan(past);
    });

    it('U1 — synonym expansion finds auth memory via login query', () => {
      // Save a memory that uses "auth" / "authentication" vocabulary.
      saveMemory(db, {
        type: 'project',
        title: 'Auth token refresh strategy',
        body: 'Authentication tokens refresh via sliding window; expiry 1h with 7d refresh.',
        importance: 0.7,
        tags: ['auth'],
        pinned: false,
      });
      // Query using synonym "login" — FTS literal miss, synonym expansion hit.
      const result = searchMemories(db, {
        query: 'login',
        token_budget: 2000,
        min_score: 0,
      });
      expect(result).toContain('Auth token refresh strategy');
    });

    it('M2 — cluster-aware eviction: singleton memory survives when cluster-mate is lower-scored', () => {
      const now = Math.floor(Date.now() / 1000);
      const ancient = now - 120 * 86400; // 4 months ago
      const insert = db.prepare(
        `INSERT INTO memories (type, title, body, importance, pinned, project, created_at, accessed_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
      );
      // Singleton in /proj-a (only member of project+type cluster).
      insert.run(
        'user',
        'Singleton pref',
        'User language preference TypeScript',
        0.3,
        '/proj-a',
        ancient,
        ancient
      );
      // Two project memories in /proj-b — the lower-scored one is a cluster-mate candidate.
      insert.run(
        'project',
        'Proj B note one',
        'Main architecture note about design',
        0.6,
        '/proj-b',
        now,
        now
      );
      insert.run(
        'project',
        'Proj B note stale',
        'Old stale note about outdated design',
        0.05,
        '/proj-b',
        ancient,
        ancient
      );

      // Fill to cap so next save triggers eviction.
      for (let i = 4; i <= 200; i++) {
        db.prepare(
          `INSERT INTO memories (type, title, body, importance, created_at, accessed_at)
           VALUES ('reference', 'Filler ${i}', 'filler body content for cap testing purposes', 0.4, ?, ?)`
        ).run(now - i * 100, now - i * 100);
      }

      saveMemory(db, {
        type: 'feedback',
        title: 'Trigger eviction test',
        body: 'This save should trigger cluster-aware eviction logic and remove the stale cluster-mate.',
        importance: 0.8,
        tags: [],
        pinned: false,
      });

      // The stale cluster-mate in /proj-b should be evicted (cluster has 2 members, so it's eligible).
      const stale = db.prepare("SELECT id FROM memories WHERE title = 'Proj B note stale'").get();
      // The singleton in /proj-a should still exist (penalized 2x in eviction sort).
      const singleton = db.prepare("SELECT id FROM memories WHERE title = 'Singleton pref'").get();
      // At least the singleton should survive.
      expect(singleton).toBeDefined();
      // Stale cluster-mate was the lowest-score non-singleton — should be gone.
      expect(stale).toBeUndefined();
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
