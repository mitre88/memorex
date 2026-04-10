#!/usr/bin/env node
import { getDb } from '../db/index.js';
import { scoreMemory, type Memory } from '../types/scoring.js';
import { TIME, PRUNE_DEFAULTS, SCORING } from '../utils/config.js';

const db = getDb();
const now = Math.floor(Date.now() / 1000);

// Delete expired
db.prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);

// Select only scoring fields — skip heavy body/tags
const cutoff = now - PRUNE_DEFAULTS.MAX_AGE_DAYS * TIME.DAY;
const old = db
  .prepare(
    'SELECT id, type, title, importance, access_count, created_at, accessed_at, expires_at FROM memories WHERE accessed_at < ?'
  )
  .all(cutoff) as Memory[];

// Type-aware prune thresholds (same as tools/index.ts)
const toDelete = old
  .filter(
    (m) =>
      scoreMemory(m) <
      (SCORING.PRUNE_THRESHOLD[m.type as keyof typeof SCORING.PRUNE_THRESHOLD] ??
        PRUNE_DEFAULTS.COLD_MEMORY_THRESHOLD)
  )
  .map((m) => m.id);

if (toDelete.length > 0) {
  db.prepare(`DELETE FROM memories WHERE id IN (${toDelete.map(() => '?').join(',')})`).run(
    ...toDelete
  );
}

db.close();
