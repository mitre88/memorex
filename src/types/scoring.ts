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
  pinned: number;
  created_at: number;
  accessed_at: number;
  expires_at: number | null;
  fts_score?: number;
}

const NOW = () => Math.floor(Date.now() / 1000);

/**
 * Score = importance × recency_decay × (1 + relevance + popularity)
 * Higher = more relevant to surface now
 *
 * FTS rank handling: SQLite BM25 returns NEGATIVE values (more negative = better match).
 * A match of -10 is strong; -0.5 is weak; 0/positive means no FTS context (fallback path).
 * Previous implementation gated on `ftsRank > 0` which was never true, so relevance
 * was pinned to 0.1 for every row. Now we normalize the magnitude into [0, 1].
 */
export function scoreMemory(m: Memory, ftsRank: number = 0): number {
  if (m.pinned) return 999; // Pinned memories always survive
  const ageDays = (NOW() - m.accessed_at) / TIME.DAY;

  // Recency decay: half-life varies by type
  const hl =
    SCORING.HALF_LIFE_DAYS[m.type as keyof typeof SCORING.HALF_LIFE_DAYS] ??
    SCORING.HALF_LIFE_DAYS.default;
  const recency = Math.pow(0.5, ageDays / hl);

  // FTS relevance: BM25 returns negatives; magnitude/norm gives [0, 1].
  // Default norm 5 means a rank of -5 maps to ~1.0 (great), -1 to 0.2, -0.1 to 0.02.
  const relevance = ftsRank < 0 ? Math.min(1, Math.abs(ftsRank) / SCORING.FTS_RANK_NORM) : 0.1;

  // Access popularity boost — /3 gives enough lift to keep frequently-used
  // memories ahead of stale ones with the same importance.
  const popularity = Math.log1p(m.access_count) / 3;

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
  const typePrefix = m.type[0].toUpperCase();
  return `#${m.id} ${typePrefix}:${m.title}|${body}`;
}
