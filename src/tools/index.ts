import Database from 'better-sqlite3';
import { z } from 'zod';
import { Memory, scoreMemory, estimateTokens, formatMemoryForContext } from '../types/scoring.js';
import {
  CONFIG,
  LIMITS,
  SCORING,
  DEFAULT_TTL_DAYS,
  SEARCH_DEFAULTS,
  PRUNE_DEFAULTS,
  TIME,
} from '../utils/config.js';
import { canSave, recordSave, sessionStats } from '../utils/session.js';
import { logger } from '../utils/logger.js';
import { getProjectRoot } from '../utils/project.js';
import { isValidProjectPath, sanitizeFtsQuery, validateTags } from '../utils/security.js';

export type SearchInputType = z.infer<typeof SearchInput>;
export const SearchInput = z.object({
  query: z.string().describe('Keywords or question'),
  project: z.string().optional().describe('Project path filter'),
  types: z.array(z.enum(['user', 'project', 'feedback', 'reference'])).optional(),
  token_budget: z.number().default(SEARCH_DEFAULTS.TOKEN_BUDGET).describe('Max tokens'),
  min_score: z.number().default(SEARCH_DEFAULTS.MIN_SCORE).describe('Min score 0-1'),
});

export type SaveInputType = z.infer<typeof SaveInput>;
export const SaveInput = z.object({
  type: z.enum(['user', 'project', 'feedback', 'reference']),
  title: z.string().describe('Title (<80 chars)'),
  body: z.string().max(LIMITS.MAX_BODY_LENGTH).describe('Content'),
  project: z.string().optional().describe('Project path'),
  tags: z.array(z.string()).default([]),
  importance: z.number().min(0).max(1).default(0.5).describe('0-1 importance'),
  ttl_days: z.number().optional().describe('Expire after N days'),
  pinned: z.boolean().default(false).describe('Never decay or prune'),
});

export type PruneInputType = z.infer<typeof PruneInput>;
export const PruneInput = z.object({
  dry_run: z.boolean().default(true).describe('Preview only'),
  max_age_days: z.number().default(PRUNE_DEFAULTS.MAX_AGE_DAYS).describe('Age threshold'),
});

export type StatsInputType = z.infer<typeof StatsInput>;
export const StatsInput = z.object({
  project: z.string().optional().describe('Project filter'),
  format: z
    .enum(['compact', 'json'])
    .default('compact')
    .describe('compact one-liner or structured JSON'),
});

export type UpdateInputType = z.infer<typeof UpdateInput>;
export const UpdateInput = z.object({
  id: z.number().describe('Memory ID'),
  body: z.string().max(LIMITS.MAX_BODY_LENGTH).optional().describe('New content'),
  importance: z.number().min(0).max(1).optional().describe('New importance'),
  pinned: z.boolean().optional().describe('Pin/unpin'),
  tags: z.array(z.string()).optional().describe('New tags'),
});

export type DeleteInputType = z.infer<typeof DeleteInput>;
export const DeleteInput = z.object({
  id: z.number().describe('Memory ID to delete'),
});

export type ContextInputType = z.infer<typeof ContextInput>;
export const ContextInput = z.object({
  project: z.string().optional().describe('Project path (defaults to cwd)'),
  token_budget: z.number().default(1500).describe('Max tokens'),
});

export function updateMemory(db: Database.Database, input: UpdateInputType): string {
  const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(input.id) as
    | { id: number }
    | undefined;
  if (!existing) return `Memory #${input.id} not found.`;

  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ['accessed_at = ?'];
  const params: (string | number)[] = [now];

  if (input.body !== undefined) {
    sets.push('body = ?');
    params.push(input.body);
  }
  if (input.importance !== undefined) {
    sets.push('importance = ?');
    params.push(input.importance);
  }
  if (input.pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(input.pinned ? 1 : 0);
  }
  if (input.tags !== undefined) {
    if (!validateTags(input.tags)) return 'Error: Invalid tags.';
    sets.push('tags = ?');
    params.push(JSON.stringify(input.tags));
  }

  params.push(input.id);
  db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return `Updated #${input.id}`;
}

export function deleteMemory(db: Database.Database, input: DeleteInputType): string {
  const existing = db.prepare('SELECT id, title FROM memories WHERE id = ?').get(input.id) as
    | { id: number; title: string }
    | undefined;
  if (!existing) return `Memory #${input.id} not found.`;
  db.prepare('DELETE FROM memories WHERE id = ?').run(input.id);
  return `Deleted #${input.id}: "${existing.title}"`;
}

export function getContext(db: Database.Database, input: ContextInputType): string {
  const now = Math.floor(Date.now() / 1000);
  // Bind to git-root by default so sub-directory cwd doesn't fragment memories.
  const project = input.project ?? getProjectRoot();

  // Get pinned memories first (always included)
  const pinned = db
    .prepare('SELECT * FROM memories WHERE pinned = 1 AND (expires_at IS NULL OR expires_at > ?)')
    .all(now) as Memory[];

  // Get project-relevant + recent high-importance memories
  const projectMems = db
    .prepare(
      `SELECT * FROM memories WHERE pinned = 0
       AND (project IS NULL OR project = ?)
       AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY importance * (1.0 / (1 + (? - accessed_at) / 86400.0)) DESC
       LIMIT 20`
    )
    .all(project, now, now) as Memory[];

  const all = [...pinned, ...projectMems];
  const scored = all
    .map((m) => ({ mem: m, score: scoreMemory(m) }))
    .sort((a, b) => b.score - a.score);

  // Dedup by id
  const seen = new Set<number>();
  const results: string[] = [];
  let tokensUsed = 0;

  for (const { mem } of scored) {
    if (seen.has(mem.id)) continue;
    seen.add(mem.id);
    const formatted = formatMemoryForContext(mem, CONFIG.MAX_DISPLAY_BODY);
    const tokens = estimateTokens(formatted);
    if (tokensUsed + tokens > input.token_budget) break;
    results.push(formatted);
    tokensUsed += tokens;
  }

  if (results.length === 0) return 'No context memories.';
  return `${results.length}|${tokensUsed}tk:\n${results.join('\n|\n')}`;
}

export type RelatedInputType = z.infer<typeof RelatedInput>;
export const RelatedInput = z.object({
  id: z.number().describe('Memory ID to find neighbors for'),
  limit: z.number().min(1).max(20).default(5).describe('Max neighbors to return'),
  min_strength: z.number().min(0).max(1).default(0.1).describe('Minimum link strength'),
});

export function getRelated(db: Database.Database, input: RelatedInputType): string {
  const source = db.prepare('SELECT id, title FROM memories WHERE id = ?').get(input.id) as
    | { id: number; title: string }
    | undefined;
  if (!source) return `Memory #${input.id} not found.`;

  const neighbors = db
    .prepare(
      `
    SELECT m.id, m.type, m.title, l.strength, l.kind
    FROM memory_links l
    JOIN memories m ON m.id = l.target_id
    WHERE l.source_id = ? AND l.strength >= ?
    ORDER BY l.strength DESC
    LIMIT ?
  `
    )
    .all(input.id, input.min_strength, input.limit) as {
    id: number;
    type: string;
    title: string;
    strength: number;
    kind: string;
  }[];

  if (neighbors.length === 0) return `No neighbors for #${input.id}: "${source.title}".`;

  const lines = neighbors.map(
    (n) => `  #${n.id} [${n.type}] ${n.title} (${n.kind}, ${n.strength.toFixed(2)})`
  );
  return `#${input.id} "${source.title}" → ${neighbors.length} neighbor(s):\n${lines.join('\n')}`;
}

export type ExportInputType = z.infer<typeof ExportInput>;
export const ExportInput = z.object({
  format: z.enum(['json', 'markdown']).default('json').describe('Export format'),
  types: z.array(z.enum(['user', 'project', 'feedback', 'reference'])).optional(),
});

export function exportMemories(db: Database.Database, input: ExportInputType): string {
  const typeFilter = input.types?.length
    ? `WHERE type IN (${input.types.map(() => '?').join(',')})`
    : '';
  const params = input.types ?? [];
  const rows = db
    .prepare(`SELECT * FROM memories ${typeFilter} ORDER BY type, created_at DESC`)
    .all(...params) as Memory[];

  if (rows.length === 0) return 'No memories to export.';

  if (input.format === 'json') {
    return JSON.stringify(rows, null, 2);
  }

  // Markdown format
  const grouped: Record<string, Memory[]> = {};
  for (const m of rows) {
    (grouped[m.type] ??= []).push(m);
  }
  const sections = Object.entries(grouped).map(([type, mems]) => {
    const items = mems
      .map(
        (m) =>
          `- **#${m.id} ${m.title}**${m.pinned ? ' 📌' : ''} (imp:${m.importance})\n  ${m.body.slice(0, 200)}`
      )
      .join('\n');
    return `## ${type}\n${items}`;
  });
  return sections.join('\n\n');
}

export function searchMemories(db: Database.Database, input: z.infer<typeof SearchInput>): string {
  const now = Math.floor(Date.now() / 1000);

  // Validate project path if provided
  if (input.project && !isValidProjectPath(input.project)) {
    return 'Error: Invalid project path format.';
  }

  // FTS search with fallback to recency
  let rows: (Memory & { fts_rank: number })[];
  try {
    const typeFilter = input.types?.length
      ? `AND m.type IN (${input.types.map(() => '?').join(',')})`
      : '';
    const projectFilter = input.project ? 'AND (m.project IS NULL OR m.project = ?)' : '';
    const safeQuery = sanitizeFtsQuery(input.query);
    const params: (string | number)[] = [safeQuery];
    if (input.types?.length) params.push(...input.types);
    if (input.project) params.push(input.project);
    params.push(now);

    // Title weighted ~10x over body so exact-title matches dominate;
    // tags weighted 3x because they're usually curated vocabulary.
    const { title: wt, body: wb, tags: wtags } = SCORING.BM25_WEIGHTS;
    rows = db
      .prepare(
        `
      SELECT m.*, bm25(memories_fts, ${wt}, ${wb}, ${wtags}) as fts_rank
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ?
        ${typeFilter}
        ${projectFilter}
        AND (m.expires_at IS NULL OR m.expires_at > ?)
      ORDER BY fts_rank
      LIMIT 25
    `
      )
      .all(...params) as (Memory & { fts_rank: number })[];
  } catch (error) {
    // FTS failed, fallback to recency (limit 10 to stay within token budget)
    logger.warn('FTS search failed, falling back to recency', { query: input.query, error });
    rows = db
      .prepare(
        `
      SELECT *, 0 as fts_rank FROM memories
      WHERE (expires_at IS NULL OR expires_at > ?)
      ORDER BY accessed_at DESC LIMIT 10
    `
      )
      .all(now) as (Memory & { fts_rank: number })[];
  }

  // Score and filter
  const scored = rows
    .map((r) => ({ mem: r, score: scoreMemory(r, r.fts_rank) }))
    .filter((x) => x.score >= input.min_score)
    .sort((a, b) => b.score - a.score);

  // Pack into token budget
  const results: string[] = [];
  let tokensUsed = 0;
  // Only refresh accessed_at if last access was >1 hour ago (prevents decay-killing)
  const ACCESS_COOLDOWN = LIMITS.ACCESS_COOLDOWN_SECONDS;
  const updateStmt = db.prepare(
    'UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ? AND accessed_at < ?'
  );

  for (const { mem } of scored) {
    const formatted = formatMemoryForContext(mem, CONFIG.MAX_DISPLAY_BODY);
    const tokens = estimateTokens(formatted);
    if (tokensUsed + tokens > input.token_budget) break;
    results.push(formatted);
    tokensUsed += tokens;
    updateStmt.run(now, mem.id, now - ACCESS_COOLDOWN);
  }

  if (results.length === 0) return 'No relevant memories found.';
  return `${results.length}|${tokensUsed}tk:\n${results.join('\n|\n')}`;
}

export function saveMemory(db: Database.Database, input: z.infer<typeof SaveInput>): string {
  const now = Math.floor(Date.now() / 1000);

  // Validate project path if provided
  if (input.project && !isValidProjectPath(input.project)) {
    return 'Error: Invalid project path format.';
  }

  // Validate tags
  if (input.tags && !validateTags(input.tags)) {
    return 'Error: Invalid tags format.';
  }

  // Bind project-typed memories to git-root when caller didn't specify one.
  // Avoids fragmenting memories across sub-directories of the same repo.
  const resolvedProject = input.project ?? (input.type === 'project' ? getProjectRoot() : null);
  // Default TTL for project type to prevent zombie memories
  const ttl = input.ttl_days ?? DEFAULT_TTL_DAYS[input.type];
  const expiresAt = ttl ? now + ttl * TIME.DAY : null;

  // Guard 1: session limit. When rate-limited we surface the three lowest-scoring
  // memories so the caller has actionable prune candidates instead of a blunt
  // "wait for next session" wall.
  if (!canSave()) {
    const candidates = db
      .prepare(
        `SELECT id, type, title, importance, access_count, created_at, accessed_at, expires_at
         FROM memories WHERE pinned = 0`
      )
      .all() as Memory[];
    const worst = candidates
      .map((m) => ({ m, score: scoreMemory(m) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map(({ m, score }) => `  #${m.id} [${m.type}] ${m.title} (score ${score.toFixed(2)})`)
      .join('\n');
    const tail = worst
      ? `\nLowest-score candidates to prune:\n${worst}\nUse memory_delete <id> or memory_prune.`
      : '\nUse memory_prune dry_run=false to free space.';
    return `Session save limit reached (${CONFIG.MAX_SAVES_PER_SESSION}/session).${tail}`;
  }

  // Guard 2: hard cap enforcement — evict lowest-score if at limit
  const totalCount = (db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number }).n;
  if (totalCount >= CONFIG.MAX_MEMORIES) {
    // Select only scoring fields — skip heavy body/tags
    const light = db
      .prepare(
        'SELECT id, type, importance, access_count, created_at, accessed_at, expires_at FROM memories'
      )
      .all() as Pick<
      Memory,
      'id' | 'type' | 'importance' | 'access_count' | 'created_at' | 'accessed_at' | 'expires_at'
    >[];
    const worst = light.reduce((a, b) =>
      scoreMemory(a as Memory) < scoreMemory(b as Memory) ? a : b
    );
    db.prepare('DELETE FROM memories WHERE id = ?').run(worst.id);
  }

  // Guard 3: fuzzy match. A title hit alone is NOT enough — we also require the
  // bodies to look alike, otherwise we merge unrelated memories that happen to
  // share topic words ("Fixed login bug" vs "Fixed logout bug"). Jaccard on
  // word bags is cheap and good enough for sub-200-row tables.
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const wordSet = (s: string, minLen = 3): Set<string> =>
    new Set(
      normalize(s)
        .split(' ')
        .filter((w) => w.length >= minLen)
    );
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 && b.size === 0) return 1;
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter);
  };

  const inputTitleWords = wordSet(input.title);
  const inputBodyWords = wordSet(input.body);
  const candidates = db
    .prepare('SELECT id, title, body FROM memories WHERE type = ?')
    .all(input.type) as { id: number; title: string; body: string }[];

  const similar = candidates.find((m) => {
    const titleWords = wordSet(m.title);
    if (inputTitleWords.size === 0 || titleWords.size === 0) return false;
    let overlap = 0;
    for (const w of inputTitleWords) if (titleWords.has(w)) overlap++;
    // Containment-based similarity: if the shorter title is fully contained in
    // the longer one, it's the "same topic". Overlap divided by the smaller
    // set catches "X documented" vs "X documented here" while still rejecting
    // "Fixed login bug" vs "Fixed logout bug".
    const titleSim = overlap / Math.min(inputTitleWords.size, titleWords.size);
    if (titleSim < SCORING.FUZZY_MATCH_THRESHOLD) return false;

    // Title looks like a dup — confirm with body. Short bodies always pass
    // because we can't compute a meaningful Jaccard on <3 words.
    if (inputBodyWords.size < 3) return true;
    const bodySim = jaccard(inputBodyWords, wordSet(m.body));
    return bodySim >= SCORING.FUZZY_BODY_SIMILARITY_MIN;
  });

  if (similar) {
    db.prepare(
      'UPDATE memories SET body = ?, tags = ?, importance = ?, accessed_at = ? WHERE id = ?'
    ).run(
      input.body,
      JSON.stringify(input.tags),
      input.importance,
      Math.floor(Date.now() / 1000),
      similar.id
    );
    return `Updated similar memory #${similar.id}: "${similar.title}" (fuzzy match for "${input.title}")`;
  }

  // Check for near-duplicate (same title + type)
  const existing = db
    .prepare('SELECT id FROM memories WHERE type = ? AND title = ? LIMIT 1')
    .get(input.type, input.title) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      'UPDATE memories SET body = ?, tags = ?, importance = ?, accessed_at = ?, expires_at = ? WHERE id = ?'
    ).run(input.body, JSON.stringify(input.tags), input.importance, now, expiresAt, existing.id);
    return `Updated existing memory #${existing.id}: "${input.title}"`;
  }

  const result = db
    .prepare(
      `
    INSERT INTO memories (type, title, body, project, tags, importance, pinned, created_at, accessed_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      input.type,
      input.title,
      input.body,
      resolvedProject,
      JSON.stringify(input.tags),
      input.importance,
      input.pinned ? 1 : 0,
      now,
      now,
      expiresAt
    );

  recordSave();

  const newId = Number(result.lastInsertRowid);
  const linkCount = autoLinkMemory(db, newId, input.title, input.body);
  const linkTail = linkCount > 0 ? ` (+${linkCount} link${linkCount === 1 ? '' : 's'})` : '';
  return `Saved memory #${newId}: "${input.title}" [${input.type}]${linkTail}`;
}

// Tiny English stopword set — enough to strip the highest-noise words before
// we build an OR query. Not about language support; it's about query quality.
const LINK_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'that',
  'this',
  'which',
  'when',
  'then',
  'than',
  'over',
  'under',
  'your',
  'have',
  'will',
  'been',
  'were',
  'they',
  'them',
  'their',
  'these',
  'those',
  'some',
  'more',
  'most',
  'other',
  'such',
  'only',
  'same',
  'each',
  'very',
  'also',
  'here',
  'there',
]);

/**
 * Extract a small set of high-signal keywords suitable for an FTS5 OR query.
 * Strips punctuation, lowercases, filters short and stopword tokens, dedups,
 * and caps at `maxTerms`. Returns an empty string when there's not enough
 * signal to link on.
 */
function buildFtsOrQuery(text: string, maxTerms = 8): string {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !LINK_STOPWORDS.has(w));
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
    if (unique.length >= maxTerms) break;
  }
  if (unique.length === 0) return '';
  return unique.join(' OR ');
}

/**
 * Auto-link a freshly-inserted memory to the top-N most similar existing ones.
 *
 * Uses the FTS5 index the memory was just indexed in. Strength is derived from
 * BM25 magnitude normalized against SCORING.FTS_RANK_NORM so it stays in [0, 1].
 * Symmetric links (target → source) are created too because for "related" kind
 * the semantics are undirected.
 *
 * NOTE on query shape: FTS5 MATCH defaults to AND between terms. Using the
 * full title+body (which can be hundreds of words) would almost never match
 * anything. We therefore extract up to ~8 high-signal keywords and OR them.
 */
function autoLinkMemory(db: Database.Database, newId: number, title: string, body: string): number {
  try {
    const query = buildFtsOrQuery(`${title} ${body}`);
    if (!query) return 0;

    const { title: wt, body: wb, tags: wtags } = SCORING.BM25_WEIGHTS;
    const rows = db
      .prepare(
        `
      SELECT m.id, bm25(memories_fts, ${wt}, ${wb}, ${wtags}) as rank
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ?
        AND m.id != ?
      ORDER BY rank
      LIMIT 3
    `
      )
      .all(query, newId) as { id: number; rank: number }[];

    if (rows.length === 0) return 0;

    // Strength = position-based halving (0.9, 0.6, 0.3 for top-3).
    // Using raw BM25 magnitude was unreliable because it scales with corpus
    // size — small corpora produce tiny magnitudes that fail any absolute
    // threshold even for true matches. Rank order is the stable signal.
    const POSITION_STRENGTH = [0.9, 0.6, 0.3];
    const insert = db.prepare(
      `INSERT OR IGNORE INTO memory_links (source_id, target_id, strength, kind)
       VALUES (?, ?, ?, 'related')`
    );
    let created = 0;
    const tx = db.transaction((links: { id: number; rank: number }[]) => {
      links.forEach((link, idx) => {
        const strength = POSITION_STRENGTH[idx] ?? 0.2;
        insert.run(newId, link.id, strength);
        insert.run(link.id, newId, strength);
        created++;
      });
    });
    tx(rows);
    return created;
  } catch {
    // Linking is best-effort; never break saves over it.
    return 0;
  }
}

export function pruneMemories(db: Database.Database, input: z.infer<typeof PruneInput>): string {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - input.max_age_days * TIME.DAY;

  // Select only fields needed for scoring - avoid fetching full body
  const candidates = db
    .prepare(
      `
    SELECT id, type, importance, access_count, created_at, accessed_at, expires_at, title
    FROM memories WHERE accessed_at < ? OR (expires_at IS NOT NULL AND expires_at < ?)
  `
    )
    .all(cutoff, now) as Memory[];

  // Type-aware prune thresholds (project decays faster → higher threshold)
  const toDelete = candidates.filter(
    (m) =>
      scoreMemory(m) <
      (SCORING.PRUNE_THRESHOLD[m.type as keyof typeof SCORING.PRUNE_THRESHOLD] ??
        SCORING.DEFAULT_PRUNE_THRESHOLD)
  );

  if (input.dry_run) {
    if (toDelete.length === 0) return 'Nothing to prune.';
    const list = toDelete.map((m) => `  #${m.id} [${m.type}] ${m.title}`).join('\n');
    return `Would delete ${toDelete.length} memories:\n${list}\n\nRun with dry_run=false to confirm.`;
  }

  const ids = toDelete.map((m) => m.id);
  if (ids.length > 0) {
    db.prepare(`DELETE FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  return `Pruned ${toDelete.length} low-relevance memories.`;
}

export function getStats(db: Database.Database, input: z.infer<typeof StatsInput>): string {
  const projectFilter = input.project ? 'WHERE project = ?' : '';
  const params = input.project ? [input.project] : [];

  const counts = db
    .prepare(
      `
    SELECT type, COUNT(*) as count FROM memories ${projectFilter} GROUP BY type
  `
    )
    .all(...params) as { type: string; count: number }[];

  const total = db
    .prepare(`SELECT COUNT(*) as n FROM memories ${projectFilter}`)
    .get(...params) as { n: number };
  const oldest = db
    .prepare(`SELECT MIN(created_at) as ts FROM memories ${projectFilter}`)
    .get(...params) as { ts: number | null };
  const pinned = db
    .prepare(
      `SELECT COUNT(*) as n FROM memories ${projectFilter ? projectFilter + ' AND' : 'WHERE'} pinned = 1`
    )
    .get(...params) as { n: number };

  const sess = sessionStats();

  if (input.format === 'json') {
    const byType: Record<string, number> = {};
    for (const r of counts) byType[r.type] = r.count;
    return JSON.stringify(
      {
        total: total.n,
        pinned: pinned.n,
        by_type: byType,
        oldest: oldest.ts ? new Date(oldest.ts * 1000).toISOString() : null,
        session: {
          saves_used: sess.saves,
          saves_remaining: sess.remaining,
          max_per_session: CONFIG.MAX_SAVES_PER_SESSION,
        },
        capacity: {
          used: total.n,
          limit: CONFIG.MAX_MEMORIES,
        },
        project: input.project ?? null,
      },
      null,
      2
    );
  }

  const typeSummary = counts.map((r) => `${r.type[0]}:${r.count}`).join(' ');
  const oldestStr = oldest.ts ? new Date(oldest.ts * 1000).toISOString().split('T')[0] : 'N/A';

  return `M:${total.n}/${CONFIG.MAX_MEMORIES} ${typeSummary} pin:${pinned.n} ${oldestStr} S:${sess.saves}/${CONFIG.MAX_SAVES_PER_SESSION}`;
}
