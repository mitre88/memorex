import { homedir } from 'os';
import { join } from 'path';

const MEMOREX_DIR = join(homedir(), '.memorex');

/** Time constants in seconds */
export const TIME = {
  SECOND: 1,
  MINUTE: 60,
  HOUR: 3600,
  DAY: 86400,
} as const;

/** Session configuration */
export const SESSION = {
  TTL_SECONDS: 4 * TIME.HOUR, // 4 hours
  MAX_SAVES: 5,
  LOCK_RETRY_ATTEMPTS: 3,
  LOCK_RETRY_BASE_DELAY_MS: 10,
} as const;

/** Memory limits and thresholds */
export const LIMITS = {
  MAX_MEMORIES: 200,
  MAX_BODY_LENGTH: 4000,
  MAX_DISPLAY_BODY: 500,
  MAX_QUERY_LENGTH: 200,
  MAX_PROJECT_PATH_LENGTH: 500,
  MAX_TAGS: 20,
  MAX_TAG_LENGTH: 50,
  ACCESS_COOLDOWN_SECONDS: TIME.HOUR, // 1 hour
  // TTL auto-promotion: if a memory accrues this many accesses within
  // PROMOTION_WINDOW_DAYS of creation, clear its expires_at (it's clearly
  // not a one-shot note — demote from "temporary" to "keep around").
  PROMOTION_MIN_ACCESSES: 5,
  PROMOTION_WINDOW_DAYS: 7,
} as const;

/** Scoring and decay parameters */
export const SCORING = {
  // Half-life in days for recency decay
  HALF_LIFE_DAYS: {
    feedback: 90,
    user: 180,
    project: 14,
    reference: 365,
    default: 60,
  } as const,
  // Prune thresholds by type (minimum score to keep)
  PRUNE_THRESHOLD: {
    project: 0.15,
    feedback: 0.1,
    user: 0.08,
    reference: 0.05,
  } as const,
  DEFAULT_PRUNE_THRESHOLD: 0.1,
  // Fuzzy match threshold (word overlap required to treat two titles as duplicates).
  // Raised from 0.7 → 0.85 because 0.7 collapsed related-but-distinct memories
  // (e.g. "Fixed login bug" vs "Fixed logout bug" share 66% and incorrectly merged).
  FUZZY_MATCH_THRESHOLD: 0.85,
  // Minimum body similarity (Jaccard on word bags) required to treat fuzzy
  // title matches as the same memory vs distinct. Below this → new memory.
  FUZZY_BODY_SIMILARITY_MIN: 0.4,
  // Token estimation (chars per token)
  CHARS_PER_TOKEN: 3,
  // BM25 field weights (title > tags > body). Passed directly to bm25().
  BM25_WEIGHTS: {
    title: 10.0,
    body: 1.0,
    tags: 3.0,
  } as const,
  // Normalization divisor used to map SQLite BM25 magnitude into [0, 1].
  // BM25 in SQLite returns negative floats (typical range -0.x to -20+).
  // Divisor of 5 maps rank −5 → ~1.0, −1 → 0.2.
  FTS_RANK_NORM: 5,
  // Half-life for memory_links strength decay (days). A link not traversed
  // via memory_related for this many days sees its effective strength halved.
  // 30 days keeps the graph fresh without aggressively pruning infrequently-
  // queried but still valid connections.
  LINK_DECAY_HALFLIFE_DAYS: 30,
} as const;

/** Default TTL for memory types in days */
export const DEFAULT_TTL_DAYS = {
  project: 30,
  feedback: undefined,
  user: undefined,
  reference: undefined,
} as const;

/** Database and file paths */
export const PATHS = {
  SESSION_FILE: join(MEMOREX_DIR, 'session.json'),
  DB_DIR: MEMOREX_DIR,
  DB_FILE: join(MEMOREX_DIR, 'memories.db'),
  LOG_DIR: join(MEMOREX_DIR, 'logs'),
} as const;

/** Search defaults */
export const SEARCH_DEFAULTS = {
  TOKEN_BUDGET: 2000,
  MIN_SCORE: 0.05,
  RESULT_LIMIT: 50,
  FALLBACK_LIMIT: 10,
} as const;

/** Pruning defaults */
export const PRUNE_DEFAULTS = {
  MAX_AGE_DAYS: 90,
  COLD_MEMORY_THRESHOLD: 0.05,
} as const;

/** Main config object (backward compatible) */
export const CONFIG = {
  MAX_MEMORIES: LIMITS.MAX_MEMORIES,
  MAX_SAVES_PER_SESSION: SESSION.MAX_SAVES,
  MAX_BODY_LENGTH: LIMITS.MAX_BODY_LENGTH,
  MAX_DISPLAY_BODY: LIMITS.MAX_DISPLAY_BODY,
  SESSION_FILE: PATHS.SESSION_FILE,
  DB_DIR: PATHS.DB_DIR,
} as const;
