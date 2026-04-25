/**
 * Analytics for `memorex gain` — RTK-style observability for the inject loop.
 *
 * Reads the `inject_events` table (populated by the UserPromptSubmit hook on
 * every prompt, success or skip) and produces both human-readable summaries
 * and JSON for machine consumers.
 *
 * Design choices:
 *
 *   - Window-based, not session-based. Users care about "the last 7 days",
 *     not "this session" — the latter is what `memory_stats` already covers.
 *   - Two views: `summary()` (one-shot last-N-days digest) and `history()`
 *     (per-day trend bucketed by ts). Both share the same SQL filter to keep
 *     numbers consistent.
 *   - Top-memories breakdown counts how often each memory id appears in the
 *     `memory_ids` JSON array of an `inject` event. Powered by SQLite
 *     `json_each` so we don't have to hydrate rows in JS.
 *   - "Hit ratio" is a heuristic, NOT a guarantee that the user actually used
 *     the memory. We approximate it as `% of inject events where the SAME
 *     session went on to log another inject event referencing at least one
 *     of the memory ids`. Crude but cheap and directionally useful.
 */
import Database from 'better-sqlite3';

export interface GainOptions {
  /** Trailing window in days. Defaults to 7. */
  days?: number;
  /** Project filter (matches inject_events.project exactly). */
  project?: string;
}

export interface GainSummary {
  window_days: number;
  project: string | null;
  total_prompts: number;
  injects: number;
  skips: { empty: number; dedup: number; error: number };
  inject_rate: number; // 0..1
  tokens_total: number;
  tokens_avg: number;
  budget_hits: number; // count of injects where tokens === budget (saturated)
  unique_memories_shown: number;
  top_memories: { id: number; count: number }[];
  hit_ratio_estimate: number; // 0..1 — see file header for caveat
  by_status: Record<string, number>;
  oldest_event_iso: string | null;
}

export interface GainHistoryDay {
  date: string; // YYYY-MM-DD
  prompts: number;
  injects: number;
  tokens: number;
}

interface InjectRow {
  id: number;
  ts: number;
  session_id: string | null;
  memory_ids: string;
  tokens: number;
  budget: number;
  status: string;
}

const SECONDS_PER_DAY = 86400;

/**
 * Build the (whereClause, params) pair shared by all queries so summary() and
 * history() always agree on what's "in window".
 */
function windowFilter(opts: GainOptions): { sql: string; params: (string | number)[] } {
  const days = Math.max(1, Math.min(365, opts.days ?? 7));
  const cutoff = Math.floor(Date.now() / 1000) - days * SECONDS_PER_DAY;
  const params: (string | number)[] = [cutoff];
  let sql = 'WHERE ts >= ?';
  if (opts.project) {
    sql += ' AND project = ?';
    params.push(opts.project);
  }
  return { sql, params };
}

export function getGainSummary(db: Database.Database, opts: GainOptions = {}): GainSummary {
  const days = Math.max(1, Math.min(365, opts.days ?? 7));
  const { sql, params } = windowFilter(opts);

  // Status counts in a single round-trip.
  const statusRows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM inject_events ${sql} GROUP BY status`)
    .all(...params) as { status: string; n: number }[];
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = r.n;

  const total =
    (byStatus.inject ?? 0) +
    (byStatus['skip-empty'] ?? 0) +
    (byStatus['skip-dedup'] ?? 0) +
    (byStatus['skip-error'] ?? 0);
  const injects = byStatus.inject ?? 0;

  // Token stats restricted to successful injects (skips contribute 0/0).
  const tokenAgg = db
    .prepare(
      `SELECT
         COALESCE(SUM(tokens), 0) AS total,
         COALESCE(AVG(tokens), 0) AS avg,
         COALESCE(SUM(CASE WHEN tokens >= budget AND budget > 0 THEN 1 ELSE 0 END), 0) AS sat
       FROM inject_events ${sql} AND status = 'inject'`
    )
    .get(...params) as { total: number; avg: number; sat: number };

  // Top memories — explode memory_ids JSON arrays via json_each, count occurrences.
  const topRaw = db
    .prepare(
      `SELECT json_each.value AS id, COUNT(*) AS n
       FROM inject_events, json_each(inject_events.memory_ids)
       ${sql.replace(/^WHERE/, 'WHERE')} AND status = 'inject'
       GROUP BY json_each.value
       ORDER BY n DESC
       LIMIT 10`
    )
    .all(...params) as { id: string | number; n: number }[];
  const topMemories = topRaw.map((r) => ({ id: Number(r.id), count: r.n }));
  const uniqueShown = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT json_each.value) AS n
         FROM inject_events, json_each(inject_events.memory_ids)
         ${sql} AND status = 'inject'`
      )
      .get(...params) as { n: number }
  ).n;

  // Hit ratio estimate: ratio of injects where ANY id later re-appears in
  // another event from the same session within ~30 minutes. Approximates
  // "the assistant followed up on the injected context".
  const hitRows = db
    .prepare(
      `SELECT id, ts, session_id, memory_ids, tokens, budget, status
       FROM inject_events ${sql} AND status = 'inject' AND session_id IS NOT NULL
       ORDER BY session_id, ts ASC`
    )
    .all(...params) as InjectRow[];
  let hits = 0;
  let denom = 0;
  // Walk forward per session; for each event, look ahead in same session
  // within 30 min for any overlapping id.
  let i = 0;
  while (i < hitRows.length) {
    const cur = hitRows[i];
    if (!cur.session_id) {
      i++;
      continue;
    }
    denom++;
    const curIds = parseIds(cur.memory_ids);
    let hit = false;
    for (let j = i + 1; j < hitRows.length; j++) {
      const next = hitRows[j];
      if (next.session_id !== cur.session_id) break;
      if (next.ts - cur.ts > 30 * 60) break; // 30-min window
      const nextIds = parseIds(next.memory_ids);
      if (curIds.some((id) => nextIds.includes(id))) {
        hit = true;
        break;
      }
    }
    if (hit) hits++;
    i++;
  }
  const hitRatio = denom > 0 ? hits / denom : 0;

  const oldest = db
    .prepare(`SELECT MIN(ts) AS ts FROM inject_events ${sql}`)
    .get(...params) as { ts: number | null };

  return {
    window_days: days,
    project: opts.project ?? null,
    total_prompts: total,
    injects,
    skips: {
      empty: byStatus['skip-empty'] ?? 0,
      dedup: byStatus['skip-dedup'] ?? 0,
      error: byStatus['skip-error'] ?? 0,
    },
    inject_rate: total > 0 ? injects / total : 0,
    tokens_total: tokenAgg.total,
    tokens_avg: injects > 0 ? Math.round(tokenAgg.total / injects) : 0,
    budget_hits: tokenAgg.sat,
    unique_memories_shown: uniqueShown,
    top_memories: topMemories,
    hit_ratio_estimate: hitRatio,
    by_status: byStatus,
    oldest_event_iso: oldest.ts ? new Date(oldest.ts * 1000).toISOString() : null,
  };
}

function parseIds(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is number => typeof x === 'number');
  } catch {
    return [];
  }
}

export function getGainHistory(db: Database.Database, opts: GainOptions = {}): GainHistoryDay[] {
  const { sql, params } = windowFilter(opts);
  // Bucket by local YYYY-MM-DD using strftime — SQLite is happy to do this.
  const rows = db
    .prepare(
      `SELECT
         strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS date,
         COUNT(*) AS prompts,
         COALESCE(SUM(CASE WHEN status = 'inject' THEN 1 ELSE 0 END), 0) AS injects,
         COALESCE(SUM(CASE WHEN status = 'inject' THEN tokens ELSE 0 END), 0) AS tokens
       FROM inject_events ${sql}
       GROUP BY date
       ORDER BY date ASC`
    )
    .all(...params) as GainHistoryDay[];
  return rows;
}

/**
 * Render a one-screen summary suitable for a terminal. Mirrors the spirit of
 * `rtk gain` so users with both tools recognize the format instantly.
 */
export function formatGainSummary(s: GainSummary): string {
  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  const lines: string[] = [];
  const scope = s.project ? ` [${s.project}]` : '';
  lines.push(`Memorex gain — last ${s.window_days}d${scope}`);
  lines.push('');
  if (s.total_prompts === 0) {
    lines.push('  No inject events recorded yet. Restart Claude Code with the v0.8.0+ hooks');
    lines.push('  installed and submit a few prompts to start collecting data.');
    return lines.join('\n');
  }
  lines.push(
    `  Prompts: ${s.total_prompts}  inject ${s.injects} (${pct(s.inject_rate)})  ` +
      `skip-empty ${s.skips.empty}  dedup ${s.skips.dedup}  error ${s.skips.error}`
  );
  lines.push(
    `  Tokens injected: ${s.tokens_total.toLocaleString()}  ` +
      `avg ${s.tokens_avg}/prompt  budget-hit ${s.budget_hits}×`
  );
  lines.push(
    `  Memories: ${s.unique_memories_shown} unique  ` +
      `hit-ratio (est) ${pct(s.hit_ratio_estimate)}`
  );
  if (s.top_memories.length > 0) {
    const top = s.top_memories
      .slice(0, 5)
      .map((m) => `#${m.id}(${m.count}×)`)
      .join('  ');
    lines.push(`  Top: ${top}`);
  }
  if (s.oldest_event_iso) {
    lines.push(`  Oldest event: ${s.oldest_event_iso.split('T')[0]}`);
  }
  return lines.join('\n');
}

export function formatGainHistory(rows: GainHistoryDay[]): string {
  if (rows.length === 0) return 'No history yet.';
  const lines: string[] = [];
  lines.push('date         prompts  injects  tokens');
  lines.push('----------   -------  -------  ------');
  for (const r of rows) {
    lines.push(
      `${r.date}   ${String(r.prompts).padStart(7)}  ${String(r.injects).padStart(7)}  ${String(r.tokens).padStart(6)}`
    );
  }
  return lines.join('\n');
}
