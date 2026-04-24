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

/**
 * SQL fragment for "memory belongs to this project OR a parent scope of it".
 *
 * A memory with project=`/foo` should match when the caller is in `/foo/bar`,
 * because saving was shallower than the query. This mirrors how git and most
 * project tools treat sub-directories. NULL projects always match.
 *
 * Requires one positional parameter for the caller's project path. Usage:
 *   WHERE ${projectHierarchyClause()}
 *   params.push(project)
 */
function projectHierarchyClause(alias = 'm'): string {
  // `? = alias.project` catches exact match; the LIKE prefix-match handles the
  // "query is deeper than the saved scope" case. We append '/' before the
  // wildcard to avoid accidental substring matches ('/foo' matching '/foobar').
  return `(${alias}.project IS NULL OR ${alias}.project = ? OR ? LIKE ${alias}.project || '/%')`;
}

/**
 * Body Jaccard threshold above which a search hit is treated as a near-
 * duplicate of an already-emitted higher-scoring hit. Absorbed hits are
 * reported via "+N similar #id" tails on the keeper row instead of
 * spending full token budget on them.
 */
const SEARCH_DEDUP_JACCARD = 0.7;

/** Word-set tokenizer for body-similarity comparisons. Shared with save-time
 *  fuzzy dedup but kept at a stricter minLen=4 since body comparisons span
 *  much larger vocabularies than titles. */
function bodyWordSet(s: string, minLen = 4): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= minLen)
  );
}

function jaccardSim(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export type SearchInputType = z.infer<typeof SearchInput>;
export const SearchInput = z.object({
  query: z.string().describe('Keywords or question'),
  project: z.string().optional().describe('Project path filter'),
  types: z.array(z.enum(['user', 'project', 'feedback', 'reference'])).optional(),
  tags: z.array(z.string()).optional().describe('Require any of these tags to match'),
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

export type HistoryInputType = z.infer<typeof HistoryInput>;
export const HistoryInput = z.object({
  id: z.number().describe('Memory ID to inspect'),
  limit: z.number().min(1).max(50).default(10).describe('Max revisions to return'),
});

/**
 * Append the PREVIOUS state of a memory to memory_revisions before overwriting
 * it. Called from any path that mutates body/tags/importance. Best-effort —
 * never breaks the caller's write.
 */
function recordRevision(db: Database.Database, id: number, reason: string): void {
  try {
    const prev = db.prepare('SELECT body, tags, importance FROM memories WHERE id = ?').get(id) as
      | { body: string; tags: string; importance: number }
      | undefined;
    if (!prev) return;
    db.prepare(
      `INSERT INTO memory_revisions (memory_id, body, tags, importance, reason)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, prev.body, prev.tags, prev.importance, reason);
  } catch {
    // Revisions are an audit trail; never block the primary write.
  }
}

export function getHistory(db: Database.Database, input: HistoryInputType): string {
  const current = db
    .prepare('SELECT id, title, body, tags, importance FROM memories WHERE id = ?')
    .get(input.id) as
    | { id: number; title: string; body: string; tags: string; importance: number }
    | undefined;
  if (!current) return `Memory #${input.id} not found.`;

  const revs = db
    .prepare(
      `SELECT id, body, tags, importance, revised_at, reason
       FROM memory_revisions WHERE memory_id = ?
       ORDER BY revised_at DESC LIMIT ?`
    )
    .all(input.id, input.limit) as {
    id: number;
    body: string;
    tags: string;
    importance: number;
    revised_at: number;
    reason: string | null;
  }[];

  const lines: string[] = [];
  lines.push(`#${current.id} "${current.title}" — current + ${revs.length} revision(s)`);
  lines.push(`  now: imp=${current.importance} ${current.body.slice(0, 120)}`);
  for (const r of revs) {
    const ts = new Date(r.revised_at * 1000).toISOString().split('T')[0];
    const reason = r.reason ? ` (${r.reason})` : '';
    lines.push(`  ${ts}${reason}: imp=${r.importance} ${r.body.slice(0, 120)}`);
  }
  return lines.join('\n');
}

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

  // Snapshot previous state before mutating — only if body/tags/importance change.
  if (input.body !== undefined || input.tags !== undefined || input.importance !== undefined) {
    recordRevision(db, input.id, 'manual-update');
  }

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

  // Single query replaces the previous pinned + project-recent pair followed
  // by JS re-dedup/re-score. Pinned rows short-circuit to a constant high
  // score (mirrors scoreMemory's pinned=999 behavior) so they always sort to
  // the top; non-pinned rows use type-aware half-life decay in SQL.
  //
  // Type half-life literals are inlined from SCORING.HALF_LIFE_DAYS; if those
  // ever shift we'd catch it via the existing scoring tests.
  const hl = SCORING.HALF_LIFE_DAYS;
  const rows = db
    .prepare(
      `
      SELECT m.*, CASE
        WHEN pinned = 1 THEN 999
        ELSE importance * pow(0.5, ((? - accessed_at) / 86400.0) /
          CASE type
            WHEN 'feedback'  THEN ${hl.feedback}
            WHEN 'user'      THEN ${hl.user}
            WHEN 'project'   THEN ${hl.project}
            WHEN 'reference' THEN ${hl.reference}
            ELSE ${hl.default}
          END
        )
      END as score
      FROM memories m
      WHERE (expires_at IS NULL OR expires_at > ?)
        AND (pinned = 1 OR m.project IS NULL OR m.project = ? OR ? LIKE m.project || '/%')
      ORDER BY score DESC
      LIMIT 30
    `
    )
    .all(now, now, project, project) as (Memory & { score: number })[];

  const results: string[] = [];
  let tokensUsed = 0;
  for (const mem of rows) {
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

export type MergeInputType = z.infer<typeof MergeInput>;
export const MergeInput = z.object({
  keep_id: z.number().describe('Memory ID to keep'),
  merge_id: z.number().describe('Memory ID to fold into keep_id then delete'),
  separator: z.string().default('\n\n---\n\n').describe('Body separator between the two halves'),
});

/**
 * Merge two memories into one. `merge_id`'s body is appended to `keep_id`'s
 * body (separated by `separator`), tags are unioned, importance is set to the
 * max of the two, and `merge_id` is deleted. The old body is captured as a
 * revision on `keep_id` first so the merge is reversible in history.
 *
 * Cascade: `merge_id`'s revisions are deleted (FK cascade). `memory_links`
 * pointing to `merge_id` are also deleted — callers who want to preserve the
 * graph should reconstruct links via `memory_save` or rely on auto-link on
 * the next save that mentions the same topic.
 */
export function mergeMemories(db: Database.Database, input: MergeInputType): string {
  if (input.keep_id === input.merge_id) {
    return 'Error: keep_id and merge_id must differ.';
  }
  const keep = db.prepare('SELECT * FROM memories WHERE id = ?').get(input.keep_id) as
    | Memory
    | undefined;
  if (!keep) return `Memory #${input.keep_id} (keep) not found.`;
  const merge = db.prepare('SELECT * FROM memories WHERE id = ?').get(input.merge_id) as
    | Memory
    | undefined;
  if (!merge) return `Memory #${input.merge_id} (merge) not found.`;

  // Union tags (both are JSON arrays in text form).
  let mergedTags: string[] = [];
  try {
    const a = JSON.parse(keep.tags || '[]') as unknown;
    const b = JSON.parse(merge.tags || '[]') as unknown;
    const arr = [
      ...(Array.isArray(a) ? (a as string[]) : []),
      ...(Array.isArray(b) ? (b as string[]) : []),
    ];
    mergedTags = [...new Set(arr)].filter((t) => typeof t === 'string').slice(0, LIMITS.MAX_TAGS);
  } catch {
    mergedTags = [];
  }

  // Combine bodies; respect MAX_BODY_LENGTH by truncating the tail if needed.
  let combined = `${keep.body}${input.separator}${merge.body}`;
  if (combined.length > LIMITS.MAX_BODY_LENGTH) {
    combined = combined.slice(0, LIMITS.MAX_BODY_LENGTH - 3) + '...';
  }
  const nextImportance = Math.max(keep.importance, merge.importance);
  const now = Math.floor(Date.now() / 1000);

  const tx = db.transaction(() => {
    recordRevision(db, keep.id, 'merge');
    db.prepare(
      'UPDATE memories SET body = ?, tags = ?, importance = ?, accessed_at = ? WHERE id = ?'
    ).run(combined, JSON.stringify(mergedTags), nextImportance, now, keep.id);
    // Deletion cascades to memory_links and memory_revisions for merge_id.
    db.prepare('DELETE FROM memories WHERE id = ?').run(merge.id);
  });
  tx();

  return `Merged #${merge.id} ("${merge.title}") into #${keep.id} ("${keep.title}"). Body ${combined.length} chars, ${mergedTags.length} tag(s).`;
}

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
    const projectFilter = input.project ? `AND ${projectHierarchyClause('m')}` : '';
    // Tag filter: match rows whose JSON tags array contains ANY of the
    // requested tags. Uses SQLite json_each which ships with better-sqlite3.
    const tagFilter = input.tags?.length
      ? `AND EXISTS (SELECT 1 FROM json_each(m.tags) WHERE json_each.value IN (${input.tags.map(() => '?').join(',')}))`
      : '';
    const safeQuery = sanitizeFtsQuery(input.query);
    const params: (string | number)[] = [safeQuery];
    if (input.types?.length) params.push(...input.types);
    if (input.project) params.push(input.project, input.project); // used twice in hierarchy clause
    if (input.tags?.length) params.push(...input.tags);
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
        ${tagFilter}
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

  // Pack into token budget with near-duplicate suppression. If two results
  // share ≥ SEARCH_DEDUP_JACCARD body-word overlap with a higher-scoring hit
  // we already emitted, skip them and attach a "+1 similar #id" tail to the
  // keeper so the caller can still find the duplicate if they want. Saves
  // tokens when two memories cover the same topic via different wordings.
  const results: string[] = [];
  const accessedIds: number[] = [];
  let tokensUsed = 0;

  interface KeeperState {
    words: Set<string>;
    lineIndex: number;
    similarIds: number[];
  }
  const keepers: KeeperState[] = [];

  for (const { mem } of scored) {
    const memWords = bodyWordSet(mem.body);
    let suppressed = false;
    for (const keeper of keepers) {
      if (jaccardSim(memWords, keeper.words) >= SEARCH_DEDUP_JACCARD) {
        keeper.similarIds.push(mem.id);
        suppressed = true;
        break;
      }
    }
    if (suppressed) continue;

    const formatted = formatMemoryForContext(mem, CONFIG.MAX_DISPLAY_BODY);
    const tokens = estimateTokens(formatted);
    if (tokensUsed + tokens > input.token_budget) break;
    results.push(formatted);
    keepers.push({ words: memWords, lineIndex: results.length - 1, similarIds: [] });
    tokensUsed += tokens;
    accessedIds.push(mem.id);
  }

  // Attach "+N similar #ids" tails to each keeper that absorbed duplicates.
  for (const keeper of keepers) {
    if (keeper.similarIds.length === 0) continue;
    const ids = keeper.similarIds.map((id) => `#${id}`).join(',');
    results[keeper.lineIndex] += ` (+${keeper.similarIds.length} similar: ${ids})`;
  }

  // Batch-update accessed_at + run TTL auto-promotion in a single transaction.
  // Wins here:
  //   (1) halves per-row SQLite fsync cost vs N separate runs.
  //   (2) v0.4.1 FTS update trigger is column-restricted, so accessed_at
  //       updates don't reindex FTS at all.
  //   (3) auto-promotion: a row hit frequently within its creation window
  //       probably shouldn't expire. We clear expires_at when access_count
  //       crosses the threshold and the row is still young.
  // Cooldown guard still prevents hot rows from resetting their decay clock.
  if (accessedIds.length > 0) {
    const ACCESS_COOLDOWN = LIMITS.ACCESS_COOLDOWN_SECONDS;
    const promoWindow = LIMITS.PROMOTION_WINDOW_DAYS * TIME.DAY;
    const updateStmt = db.prepare(
      'UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ? AND accessed_at < ?'
    );
    // Promotion fires after the access_count increment, so we check >=
    // PROMOTION_MIN_ACCESSES inclusive. `AND expires_at IS NOT NULL` keeps
    // us from churning on already-permanent rows.
    const promoteStmt = db.prepare(
      `UPDATE memories SET expires_at = NULL
       WHERE id = ?
         AND expires_at IS NOT NULL
         AND access_count >= ?
         AND created_at > ?`
    );
    const tx = db.transaction((ids: number[]) => {
      for (const id of ids) {
        updateStmt.run(now, id, now - ACCESS_COOLDOWN);
        promoteStmt.run(id, LIMITS.PROMOTION_MIN_ACCESSES, now - promoWindow);
      }
    });
    tx(accessedIds);
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

  // Guard 2: hard cap enforcement. Instead of pulling every row into JS to
  // find the worst, let SQLite do it. The scoring expression mirrors
  // scoreMemory() for non-pinned, non-expired rows:
  //
  //   score = importance * 2^(-age_days / half_life)
  //
  // (popularity boost and FTS relevance are both 0 here — eviction never has
  // an FTS context and access_count contribution is minor at eviction time.)
  //
  // Pinned rows are excluded. Expired rows are preferred for eviction.
  const totalCount = (db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number }).n;
  if (totalCount >= CONFIG.MAX_MEMORIES) {
    const hl = SCORING.HALF_LIFE_DAYS;
    const evictStmt = db.prepare(`
      DELETE FROM memories WHERE id = (
        SELECT id FROM memories WHERE pinned = 0
        ORDER BY
          CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN 0 ELSE 1 END,
          importance * pow(0.5, ((? - accessed_at) / 86400.0) /
            CASE type
              WHEN 'feedback'  THEN ${hl.feedback}
              WHEN 'user'      THEN ${hl.user}
              WHEN 'project'   THEN ${hl.project}
              WHEN 'reference' THEN ${hl.reference}
              ELSE ${hl.default}
            END
          ) ASC
        LIMIT 1
      )
    `);
    evictStmt.run(now, now);
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
    recordRevision(db, similar.id, 'fuzzy-merge');
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
    recordRevision(db, existing.id, 'upsert');
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

  // One round-trip instead of four. Conditional aggregates compute the per-type
  // counts + pinned + oldest + total in a single table scan.
  const agg = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(pinned) as pinned_n,
        MIN(created_at) as oldest,
        SUM(CASE WHEN type = 'user'      THEN 1 ELSE 0 END) as t_user,
        SUM(CASE WHEN type = 'project'   THEN 1 ELSE 0 END) as t_project,
        SUM(CASE WHEN type = 'feedback'  THEN 1 ELSE 0 END) as t_feedback,
        SUM(CASE WHEN type = 'reference' THEN 1 ELSE 0 END) as t_reference
       FROM memories ${projectFilter}`
    )
    .get(...params) as {
    total: number;
    pinned_n: number | null;
    oldest: number | null;
    t_user: number | null;
    t_project: number | null;
    t_feedback: number | null;
    t_reference: number | null;
  };

  const byType: Record<string, number> = {};
  if (agg.t_user) byType.user = agg.t_user;
  if (agg.t_project) byType.project = agg.t_project;
  if (agg.t_feedback) byType.feedback = agg.t_feedback;
  if (agg.t_reference) byType.reference = agg.t_reference;
  const pinnedCount = agg.pinned_n ?? 0;
  const sess = sessionStats();

  if (input.format === 'json') {
    return JSON.stringify(
      {
        total: agg.total,
        pinned: pinnedCount,
        by_type: byType,
        oldest: agg.oldest ? new Date(agg.oldest * 1000).toISOString() : null,
        session: {
          saves_used: sess.saves,
          saves_remaining: sess.remaining,
          max_per_session: CONFIG.MAX_SAVES_PER_SESSION,
        },
        capacity: {
          used: agg.total,
          limit: CONFIG.MAX_MEMORIES,
        },
        project: input.project ?? null,
      },
      null,
      2
    );
  }

  const typeSummary = Object.entries(byType)
    .map(([k, v]) => `${k[0]}:${v}`)
    .join(' ');
  const oldestStr = agg.oldest ? new Date(agg.oldest * 1000).toISOString().split('T')[0] : 'N/A';

  return `M:${agg.total}/${CONFIG.MAX_MEMORIES} ${typeSummary} pin:${pinnedCount} ${oldestStr} S:${sess.saves}/${CONFIG.MAX_SAVES_PER_SESSION}`;
}
