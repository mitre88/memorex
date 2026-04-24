#!/usr/bin/env node
/**
 * Micro-benchmark for memorex hot paths. Seeds a throwaway DB with N rows,
 * then times representative operations:
 *
 *   - getDb() cold open (first call after file exists)
 *   - getDb() warm open (schema version gate short-circuit)
 *   - getDbReadonly() open
 *   - searchMemories on a 200-row corpus
 *   - getContext on a 200-row corpus
 *   - saveMemory at 200-row cap (exercises SQL eviction)
 *
 * Run: node scripts/bench.mjs
 * Requires: `npm run build` first.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getDb, getDbReadonly } from '../dist/db/index.js';
import {
  searchMemories,
  saveMemory,
  getStats,
} from '../dist/tools/index.js';
// Context import used via dynamic import below because top-level default
// path varies with tooling; keep bench tolerant.
import { getContext } from '../dist/tools/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'memorex-bench-'));
const dbPath = join(tmp, 'bench.db');

function ms(start) {
  return (performance.now() - start).toFixed(2);
}

function time(label, iters, fn) {
  // Warmup
  for (let i = 0; i < Math.min(5, iters); i++) fn(i);
  const start = performance.now();
  for (let i = 0; i < iters; i++) fn(i);
  const total = performance.now() - start;
  const per = (total / iters).toFixed(3);
  console.log(`  ${label.padEnd(40)} ${iters.toString().padStart(5)} iters  ${per} ms/op   (${total.toFixed(0)} ms total)`);
}

function seedCorpus(db, n) {
  const insert = db.prepare(
    `INSERT INTO memories (type, title, body, project, importance, accessed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const types = ['user', 'project', 'feedback', 'reference'];
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const age = Math.floor(Math.random() * 90) * 86400;
      insert.run(
        types[i % types.length],
        `Seed memory ${i} about topic ${i % 20}`,
        `Body text ${i} discussing implementation details and technical tradeoffs for topic ${i % 20}.`,
        i % 3 === 0 ? '/tmp/project-a' : '/tmp/project-b',
        0.3 + (i % 10) / 20,
        now - age,
        now - age
      );
    }
  });
  tx();
}

console.log('memorex bench — single-file tempdb, 200-row corpus\n');

// --- DB open benchmarks ---
console.log('DB open:');
// Cold: first open creates + migrates.
{
  const start = performance.now();
  const db = getDb({ path: dbPath });
  console.log(`  getDb cold open (create+migrate)              ${ms(start)} ms`);
  seedCorpus(db, 200);
  db.close();
}
// Warm: user_version already current — applySchema short-circuits.
time('getDb warm open', 20, () => {
  const db = getDb({ path: dbPath });
  db.close();
});
time('getDbReadonly open', 20, () => {
  const db = getDbReadonly({ path: dbPath });
  db?.close();
});

// --- Hot path: search / context / stats ---
console.log('\nHot paths (200-row corpus):');
{
  const db = getDb({ path: dbPath });
  time('searchMemories("topic")', 50, () =>
    searchMemories(db, { query: 'topic', token_budget: 2000, min_score: 0.01 })
  );
  time('getContext (git-root scope)', 50, () =>
    getContext(db, { project: '/tmp/project-a', token_budget: 1500 })
  );
  time('getStats compact', 100, () => getStats(db, { format: 'compact' }));
  time('getStats json', 100, () => getStats(db, { format: 'json' }));
  db.close();
}

// --- Eviction at cap ---
console.log('\nEviction (at 200-row cap):');
{
  const db = getDb({ path: dbPath });
  // Force to exactly cap and measure a save that evicts.
  const count = db.prepare('SELECT COUNT(*) as n FROM memories').get().n;
  if (count < 200) {
    for (let i = 0; i < 200 - count; i++) {
      db.prepare(
        `INSERT INTO memories (type, title, body, importance, accessed_at, created_at)
         VALUES ('project', ?, ?, 0.1, ?, ?)`
      ).run(`Pad ${i}`, 'Padding body text here', 1, 1);
    }
  }
  time('saveMemory triggering SQL eviction', 20, (i) =>
    saveMemory(db, {
      type: 'project',
      title: `Fresh bench save ${i}`,
      body: `Body content for save iteration ${i} covering details.`,
      importance: 0.5,
      tags: [],
      pinned: false,
    })
  );
  db.close();
}

rmSync(tmp, { recursive: true, force: true });
console.log('\ndone.');
