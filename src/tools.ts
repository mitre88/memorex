import Database from 'better-sqlite3';
import { z } from 'zod';
import { Memory, scoreMemory, estimateTokens, formatMemoryForContext } from './scoring.js';
import { CONFIG } from './config.js';
import { canSave, recordSave } from './session.js';
import { sessionStats } from './session.js';

export const SearchInput = z.object({
  query: z.string().describe('Search query — keywords, topic, or question'),
  project: z.string().optional().describe('Filter to specific project path'),
  types: z.array(z.enum(['user', 'project', 'feedback', 'reference'])).optional(),
  token_budget: z.number().default(2000).describe('Max tokens to return'),
  min_score: z.number().default(0.05).describe('Minimum relevance score (0-1)'),
});

export const SaveInput = z.object({
  type: z.enum(['user', 'project', 'feedback', 'reference']),
  title: z.string().describe('Short title (< 80 chars)'),
  body: z.string().max(1500).describe('Memory content (max 1500 chars)'),
  project: z.string().optional().describe('Project path this applies to'),
  tags: z.array(z.string()).default([]),
  importance: z.number().min(0).max(1).default(0.5).describe('0=low, 0.5=normal, 1=critical'),
  ttl_days: z.number().optional().describe('Auto-expire after N days. Default: 30 for project type'),
});

export const PruneInput = z.object({
  dry_run: z.boolean().default(true).describe('If true, only report what would be deleted'),
  max_age_days: z.number().default(90).describe('Delete memories older than this (if score < 0.1)'),
});

export const StatsInput = z.object({
  project: z.string().optional(),
});

export function searchMemories(db: Database.Database, input: z.infer<typeof SearchInput>): string {
  const now = Math.floor(Date.now() / 1000);

  // FTS search
  let rows: (Memory & { fts_rank: number })[] = [];
  try {
    const typeFilter = input.types?.length
      ? `AND m.type IN (${input.types.map(() => '?').join(',')})`
      : '';
    const projectFilter = input.project ? 'AND (m.project IS NULL OR m.project = ?)' : '';
    const params: (string | number)[] = [input.query];
    if (input.types?.length) params.push(...input.types);
    if (input.project) params.push(input.project);
    params.push(now);

    rows = db.prepare(`
      SELECT m.*, fts.rank as fts_rank
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.rowid
      WHERE memories_fts MATCH ?
        ${typeFilter}
        ${projectFilter}
        AND (m.expires_at IS NULL OR m.expires_at > ?)
      ORDER BY fts.rank
      LIMIT 50
    `).all(...params) as (Memory & { fts_rank: number })[];
  } catch {
    // FTS failed, fallback to recency
    rows = db.prepare(`
      SELECT *, 0 as fts_rank FROM memories
      WHERE (expires_at IS NULL OR expires_at > ?)
      ORDER BY accessed_at DESC LIMIT 30
    `).all(now) as (Memory & { fts_rank: number })[];
  }

  // Score and filter
  const scored = rows
    .map(r => ({ mem: r, score: scoreMemory(r, r.fts_rank) }))
    .filter(x => x.score >= input.min_score)
    .sort((a, b) => b.score - a.score);

  // Pack into token budget
  const results: string[] = [];
  let tokensUsed = 0;
  // Only refresh accessed_at if last access was >1 hour ago (prevents decay-killing)
  const ACCESS_COOLDOWN = 3600;
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
  return `Found ${results.length} memories (~${tokensUsed} tokens):\n\n${results.join('\n\n---\n\n')}`;
}

export function saveMemory(db: Database.Database, input: z.infer<typeof SaveInput>): string {
  const now = Math.floor(Date.now() / 1000);
  // Default TTL for project type (30 days) to prevent zombie memories
  const ttl = input.ttl_days ?? (input.type === 'project' ? 30 : undefined);
  const expiresAt = ttl ? now + ttl * 86400 : null;

  // Guard 1: session limit
  if (!canSave()) {
    return `Session save limit reached (${CONFIG.MAX_SAVES_PER_SESSION}/session). Use memory_prune to free space or wait for new session.`;
  }

  // Guard 2: hard cap enforcement — evict lowest-score if at limit
  const totalCount = (db.prepare('SELECT COUNT(*) as n FROM memories').get() as {n: number}).n;
  if (totalCount >= CONFIG.MAX_MEMORIES) {
    // Select only scoring fields — skip heavy body/tags
    const light = db.prepare(
      'SELECT id, type, importance, access_count, created_at, accessed_at, expires_at FROM memories'
    ).all() as Pick<Memory, 'id'|'type'|'importance'|'access_count'|'created_at'|'accessed_at'|'expires_at'>[];
    const worst = light.reduce((a, b) =>
      scoreMemory(a as Memory) < scoreMemory(b as Memory) ? a : b
    );
    db.prepare('DELETE FROM memories WHERE id = ?').run(worst.id);
  }

  // Guard 3: fuzzy title match (normalized lowercase, strip punctuation)
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const normTitle = normalize(input.title);
  const similar = (db.prepare('SELECT id, title FROM memories WHERE type = ?').all(input.type) as {id:number,title:string}[])
    .find(m => {
      const nt = normalize(m.title);
      // Simple overlap: if one title contains 70%+ of the other's words
      const aWords = new Set(normTitle.split(' ').filter(w => w.length > 3));
      const bWords = new Set(nt.split(' ').filter(w => w.length > 3));
      if (aWords.size === 0) return false;
      const overlap = [...aWords].filter(w => bWords.has(w)).length;
      return overlap / aWords.size >= 0.7;
    });

  if (similar) {
    db.prepare('UPDATE memories SET body = ?, tags = ?, importance = ?, accessed_at = ? WHERE id = ?')
      .run(input.body, JSON.stringify(input.tags), input.importance, Math.floor(Date.now()/1000), similar.id);
    return `Updated similar memory #${similar.id}: "${similar.title}" (fuzzy match for "${input.title}")`;
  }

  // Check for near-duplicate (same title + type)
  const existing = db.prepare(
    'SELECT id FROM memories WHERE type = ? AND title = ? LIMIT 1'
  ).get(input.type, input.title) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      'UPDATE memories SET body = ?, tags = ?, importance = ?, accessed_at = ?, expires_at = ? WHERE id = ?'
    ).run(input.body, JSON.stringify(input.tags), input.importance, now, expiresAt, existing.id);
    return `Updated existing memory #${existing.id}: "${input.title}"`;
  }

  const result = db.prepare(`
    INSERT INTO memories (type, title, body, project, tags, importance, created_at, accessed_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.type, input.title, input.body, input.project ?? null, JSON.stringify(input.tags), input.importance, now, now, expiresAt);

  recordSave();
  return `Saved memory #${result.lastInsertRowid}: "${input.title}" [${input.type}]`;
}

export function pruneMemories(db: Database.Database, input: z.infer<typeof PruneInput>): string {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - input.max_age_days * 86400;

  const candidates = db.prepare(`
    SELECT * FROM memories WHERE accessed_at < ? OR (expires_at IS NOT NULL AND expires_at < ?)
  `).all(cutoff, now) as Memory[];

  // Type-aware prune thresholds (project decays faster → higher threshold)
  const pruneThreshold: Record<string, number> = {
    project: 0.15,
    feedback: 0.1,
    user: 0.08,
    reference: 0.05,
  };
  const toDelete = candidates.filter(m => scoreMemory(m) < (pruneThreshold[m.type] ?? 0.1));

  if (input.dry_run) {
    if (toDelete.length === 0) return 'Nothing to prune.';
    const list = toDelete.map(m => `  #${m.id} [${m.type}] ${m.title}`).join('\n');
    return `Would delete ${toDelete.length} memories:\n${list}\n\nRun with dry_run=false to confirm.`;
  }

  const ids = toDelete.map(m => m.id);
  if (ids.length > 0) {
    db.prepare(`DELETE FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  return `Pruned ${toDelete.length} low-relevance memories.`;
}

export function getStats(db: Database.Database, input: z.infer<typeof StatsInput>): string {
  const projectFilter = input.project ? 'WHERE project = ?' : '';
  const params = input.project ? [input.project] : [];

  const counts = db.prepare(`
    SELECT type, COUNT(*) as count FROM memories ${projectFilter} GROUP BY type
  `).all(...params) as { type: string; count: number }[];

  const total = db.prepare(`SELECT COUNT(*) as n FROM memories ${projectFilter}`).get(...params) as { n: number };
  const oldest = db.prepare(`SELECT MIN(created_at) as ts FROM memories ${projectFilter}`).get(...params) as { ts: number | null };

  const typeLines = counts.map(r => `  ${r.type}: ${r.count}`).join('\n');
  const oldestStr = oldest.ts ? new Date(oldest.ts * 1000).toISOString().split('T')[0] : 'N/A';
  const sess = sessionStats();

  return `Memorex stats:\n  Total: ${total.n}\n${typeLines}\n  Oldest: ${oldestStr}\n  Session: ${sess.saves}/${CONFIG.MAX_SAVES_PER_SESSION} saves used`;
}
