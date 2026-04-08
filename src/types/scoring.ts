import { TIME, SCORING } from '../utils/config.js';

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

/**
 * Score = importance × recency_decay × relevance_boost × type_weight
 * Higher = more relevant to surface now
 */
export function scoreMemory(m: Memory, ftsRank: number = 0): number {
  const ageDays = (NOW() - m.accessed_at) / TIME.DAY;

  // Recency decay: half-life varies by type
  const hl =
    SCORING.HALF_LIFE_DAYS[m.type as keyof typeof SCORING.HALF_LIFE_DAYS] ??
    SCORING.HALF_LIFE_DAYS.default;
  const recency = Math.pow(0.5, ageDays / hl);

  // FTS relevance (lower bm25 rank = better match in SQLite FTS5)
  const relevance = ftsRank > 0 ? 1 / (1 + Math.abs(ftsRank)) : 0.1;

  // Access popularity boost
  const popularity = Math.log1p(m.access_count) / 10;

  return m.importance * recency * (1 + relevance + popularity);
}

export function estimateTokens(text: string): number {
  // ~3 chars per token for code/mixed content (more accurate than 4)
  return Math.ceil(text.length / SCORING.CHARS_PER_TOKEN);
}

export function formatMemoryForContext(m: Memory, maxBody: number = 500): string {
  // Truncate at sentence boundary if possible
  let body = m.body;
  if (body.length > maxBody) {
    const truncated = body.slice(0, maxBody);
    const lastSentence = truncated.match(/.*[.!?]\s*/);
    body = lastSentence ? lastSentence[0].trim() : truncated + '...';
  }
  // Compact format: type as single letter prefix
  const typePrefix = m.type[0].toUpperCase();
  return `${typePrefix}:${m.title}|${body}`;
}
