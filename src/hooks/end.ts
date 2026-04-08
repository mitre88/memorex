#!/usr/bin/env node
import { getDb } from '../db/index.js';
import { scoreMemory, type Memory } from '../types/scoring.js';

const db = getDb();
const now = Math.floor(Date.now() / 1000);

// Delete expired
db.prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);

// Delete memories not accessed in 90+ days with score < 0.05
const cutoff = now - 90 * 86400;
const old = db.prepare('SELECT * FROM memories WHERE accessed_at < ?').all(cutoff) as Memory[];
const toDelete = old.filter((m) => scoreMemory(m) < 0.05).map((m) => m.id);
if (toDelete.length > 0) {
  db.prepare(`DELETE FROM memories WHERE id IN (${toDelete.map(() => '?').join(',')})`).run(
    ...toDelete
  );
}

db.close();
// Intentionally no output — runs silently after session
