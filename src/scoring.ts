export interface Memory {
  id: number;
  type: string;
  title: string;
  body: string;
  project: string | null;
  tags: string;
  importance: number;
  access_count: number;
  created_at: number;
  accessed_at: number;
  expires_at: number | null;
  fts_score?: number;
}

const NOW = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

/**
 * Score = importance × recency_decay × relevance_boost × type_weight
 * Higher = more relevant to surface now
 */
export function scoreMemory(m: Memory, ftsRank: number = 0): number {
  const ageDays = (NOW() - m.accessed_at) / DAY;

  // Recency decay: half-life varies by type
  const halfLife: Record<string, number> = {
    feedback: 90,
    user: 180,
    project: 14,
    reference: 365,
  };
  const hl = halfLife[m.type] ?? 60;
  const recency = Math.pow(0.5, ageDays / hl);

  // FTS relevance (lower bm25 rank = better match in SQLite FTS5)
  const relevance = ftsRank > 0 ? 1 / (1 + Math.abs(ftsRank)) : 0.1;

  // Access popularity boost
  const popularity = Math.log1p(m.access_count) / 10;

  return m.importance * recency * (1 + relevance + popularity);
}

export function estimateTokens(text: string): number {
  // ~4 chars per token (rough estimate)
  return Math.ceil(text.length / 4);
}

export function formatMemoryForContext(m: Memory, maxBody: number = 500): string {
  const body = m.body.length > maxBody
    ? m.body.slice(0, maxBody) + '...'
    : m.body;
  return `[${m.type.toUpperCase()}] ${m.title}\n${body}`;
}
