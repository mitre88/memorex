import type Database from 'better-sqlite3';
import { CONFIG, SCORING } from '../utils/config.js';

/**
 * Enforce the 200-memory hard cap by deleting one lowest-score unpinned row.
 * Used by saveMemory and by importers (insertRaw used to skip this and grow
 * past the cap).
 *
 * Scoring matches scoreMemory() for non-pinned rows:
 *   score = importance * 2^(-age_days / half_life)
 * Cluster-aware: the sole member of a (project × type) cluster is 2× harder
 * to evict. Expired rows are always preferred.
 */
export function evictOneIfAtCap(
  db: Database.Database,
  now: number = Math.floor(Date.now() / 1000)
): void {
  const totalCount = (db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number }).n;
  if (totalCount < CONFIG.MAX_MEMORIES) return;

  const hl = SCORING.HALF_LIFE_DAYS;
  db.prepare(
    `
      DELETE FROM memories WHERE id = (
        SELECT m.id FROM memories m WHERE m.pinned = 0
        ORDER BY
          CASE WHEN m.expires_at IS NOT NULL AND m.expires_at < ? THEN 0 ELSE 1 END,
          importance * pow(0.5, ((? - m.accessed_at) / 86400.0) /
            CASE m.type
              WHEN 'feedback'  THEN ${hl.feedback}
              WHEN 'user'      THEN ${hl.user}
              WHEN 'project'   THEN ${hl.project}
              WHEN 'reference' THEN ${hl.reference}
              ELSE ${hl.default}
            END
          ) * CASE
              WHEN (SELECT COUNT(*) FROM memories c
                    WHERE COALESCE(c.project, '__g') = COALESCE(m.project, '__g')
                      AND c.type = m.type AND c.id != m.id) > 0
                THEN 1.0
              ELSE 2.0
            END ASC
        LIMIT 1
      )
    `
  ).run(now, now);
}
