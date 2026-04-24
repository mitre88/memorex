# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-04-23

Sprint 2 from the Utility + Token-Savings plan. Five focused changes
covering hook cold-start, search token economy, memory lifecycle, and
session recovery.

### Added

- **U5 — `memory_merge` MCP tool** (and `memorex merge <keep_id> <merge_id>`
  CLI command). Concatenates bodies with a separator, unions tags,
  takes the max importance, captures a `merge` revision on `keep_id`
  before mutating, then deletes `merge_id`. FK cascade handles links and
  revisions of the removed row.
- **U4 — Stop hook now synthesizes a session summary memory.** On session
  close the hook walks the transcript and stores a 14-day project memory
  with the last 5 user prompts, files touched, and duration, tagged
  `session-summary`. Complements the existing PreCompact snapshot so
  normal session end is also recoverable from the next session.
- **T2 — Search result dedup.** Hits whose body Jaccard exceeds
  `SEARCH_DEDUP_JACCARD` (0.7) with an already-emitted higher-scoring
  keeper are suppressed and reported as a `+N similar #id` tail on the
  keeper line. Saves tokens when two memories cover the same topic with
  different wording.
- **U6 — TTL auto-promotion.** A memory that accrues `PROMOTION_MIN_ACCESSES`
  (5) hits within `PROMOTION_WINDOW_DAYS` (7) of creation has its
  `expires_at` cleared automatically in the `searchMemories` batch update.
  Stops useful memories from expiring out from under the user.

### Performance

- **P1 — hooks are now bundled with esbuild.** Internal modules collapse
  into a single ESM file per hook; only `better-sqlite3` (native) stays
  external. Measured cold-start: **~40 ms/hook** down from **~50 ms/hook**
  before bundling (~20 % saving, ~40-50 ms per session across 4–5 hook
  invocations). `npm run build` chains `tsc && node scripts/build-hooks.mjs`.

### Benchmark delta vs 0.5.0 on 200-row corpus

Composite win from porter tokenizer, new indexes, and bundled hooks:

- `getDb` cold: **7.8 ms** (was 18.9 ms)
- `getDb` warm: **0.35 ms/op** (was 0.88 ms/op)
- `getDbReadonly`: **0.033 ms/op**
- `searchMemories`: **0.17 ms/op** (was 0.31 ms/op)
- `getContext`: **0.08 ms/op** (was 0.23 ms/op)
- `getStats` compact: **0.05 ms/op** (was 0.08 ms/op)
- `saveMemory` with eviction: **0.18 ms/op** (was 0.26 ms/op)

### Dev

- New dev dep: `esbuild ^0.28`. No change to production dependencies.
- New `npm run build:tsc` that runs TypeScript only (useful during test
  authoring when you don't want to re-bundle every time).
- `src/__tests__/tools.test.ts` adds 4 cases covering search dedup, TTL
  auto-promotion, merge, and merge-validation. Total: 55 tests.

## [0.5.0] - 2026-04-23

Sprint 1 from the Utility + Token-Savings plan. Six focused changes, one
DB migration (v5), measurable token savings on auto-inject, better recall
on natural-language queries.

### Added

- **T1 — Session-scoped LRU dedup for auto-inject.** Every injection writes
  its chosen memory IDs to `~/.memorex/inject-lru.json` keyed by session id.
  The next prompt in the same session skips candidates that were injected
  in the last ~20 turns (4h TTL). Saves 20–40 % of auto-inject tokens in
  long sessions where the same memories would otherwise re-appear every turn.
- **U3 — `tags` filter on `memory_search`.** Pass `tags: ["decision","auth"]`
  to restrict hits to memories carrying any of those tags. Implemented with
  SQLite `json_each` for correctness on arbitrary tag arrays.
- **T3 — Adaptive inject budget.** Token budget now scales with prompt
  length: short prompts ("continue") get 200 tokens, long prompts get up to
  the `MEMOREX_INJECT_BUDGET` ceiling. Formula: `clamp(180 + 0.5·chars,
200, ceiling)`.
- **T4 — Compact inject wrapper.** XML preamble dropped from 55 chars to
  19 (`<memorex>`). Per-memory line switched from `#1 P:Title|body` to
  `1/P Title: body`. Pure token savings, same information.

### Changed

- **P2 — FTS5 now uses the Porter stemmer** (`tokenize='porter unicode61'`).
  Queries like "update" match memories written about "updating" / "updates"
  / "updated". Migration v5 drops and rebuilds the FTS index from the base
  table — safe because FTS is derived state.
- **U2 — Project hierarchy matching.** A memory whose `project` column is
  `/repo` now matches queries scoped to `/repo/packages/ui`. Prefix-aware
  clause: `project = ? OR ? LIKE project || '/%'`. Fixes the longstanding
  annoyance where saving at repo root hid memories from sub-directory work.
- **`isValidProjectPath` no longer jails to `$HOME`.** Git repos in `/tmp`,
  `/private/var` (macOS realpath), system paths, etc. now validate cleanly.
  Length and traversal protections remain.

### Performance

- `getDbReadonly` open: **0.042 ms/op** (down from 0.097 ms/op in v0.4.1 —
  measurement run; the open path itself didn't change, this is variance).
- `saveMemory` triggering SQL eviction: **0.264 ms/op** (from 0.574 ms/op)
  thanks to new indexes biting in the eviction sort.
- `getStats` consolidated query: **0.08 ms/op** (from 0.14 ms/op compact).

## [0.4.1] - 2026-04-23

Pure performance pass. No API changes. No behavior changes other than speed
and fewer writes per operation.

### Performance

- **FTS update trigger is now column-restricted** (`UPDATE OF title, body, tags`).
  Previously the trigger fired on ANY update, so every `searchMemories` call
  that refreshed `accessed_at` on a result row caused a full FTS5
  delete+reinsert of that row. A search returning 3 hits used to trigger 3
  FTS re-indexes. Now those updates bypass FTS entirely.
- **Schema migrations are gated on `PRAGMA user_version`**. Four hook
  processes boot per session (`SessionStart`, `UserPromptSubmit`, `PreCompact`,
  `SubagentStop`, `Stop`); each one used to re-parse 3 triggers + 4
  `CREATE TABLE IF NOT EXISTS` + a virtual FTS table on every boot. Now the
  second-and-later opens short-circuit when `user_version` is current.
- **Read-only DB handle for `UserPromptSubmit` hook**. Auto-inject is a pure
  read path; opening with `{readonly: true}` skips WAL setup, chmod, and the
  entire migration path. Returns null on missing DB → silent fresh-install
  exit without try/catch ceremony.
- **Disk-cached git project root** at `~/.memorex/project-cache.json`. Before:
  every hook invocation shelled out to `git rev-parse --show-toplevel`
  (~20–50ms). After: first hook populates cache, subsequent ones read JSON.
  1-hour TTL for safety if repos move.
- **SQL-side eviction.** At the 200-memory hard cap, `saveMemory` used to
  pull every row's scoring fields into JS and reduce to find the worst. Now
  a single `DELETE WHERE id = (SELECT … ORDER BY score ASC LIMIT 1)` using
  inline `pow(0.5, age/halflife)` does the work in the engine.
- **`memory_context` unified to a single query** with CASE-based scoring and
  pinned short-circuit; was previously 2 round-trips + JS dedup + JS sort.
- **`memory_stats` consolidated to a single query** with conditional
  aggregates. Was 4 round-trips (GROUP BY, total, oldest, pinned count).
- **Transactional `accessed_at` batch update in `searchMemories`.** N separate
  UPDATEs → one `db.transaction` tx. Halves SQLite fsync cost on the search
  hot path.
- **Inject hook fetch size cut** from `SEARCH_DEFAULTS.RESULT_LIMIT` (50) to
  `INJECT_MAX_RESULTS * 4` (default 12). Matches the actual scoring headroom
  we need for min-score filtering.
- **Hot-path indexes added**: `idx_memories_recency` (pinned, accessed_at),
  `idx_memories_type_title`, `idx_memories_project`, `idx_memories_expires`
  (partial). Measurable on CLI `ls`, `memory_context`, and prune queries.

### Internal

- `getDb()` and `getDbReadonly()` now accept an optional `{path}` override
  for tests, so the suite no longer depends on `process.env.HOME` mutation
  reaching module-loaded `PATHS`.
- New `scripts/bench.mjs` script and 6 new db-init tests covering the
  migration gate, readonly mode, and column-restricted trigger.

## [0.4.0] - 2026-04-23

### Added

- **CLI** — the `memorex` binary now dispatches to a full CLI when invoked with
  arguments. Commands: `ls`, `search`, `show`, `pin`, `unpin`, `rm`, `stats`,
  `history`, `prune`, `backup`, `import`, `version`, `help`. Calling with no
  args (the MCP stdio invocation path) still starts the MCP server.
- **`SubagentStop` hook** — captures the synthesized result of every sub-agent
  delegation as a `feedback` memory tagged `subagent` and `agent-<name>` with
  a 30-day TTL. Makes past delegations searchable.
- **Importers** — bootstrap memorex from existing knowledge bases:
  `memorex import --from claude-md <path>` (one memory per H2 section),
  `--from obsidian <vault>` (one memory per `.md`, folder path as tags),
  `--from engram <json>` (array of observations or
  `{ observations: [...] }`). All bypass the session save rate limit but
  respect the 200-memory hard cap.
- **Revision history** — new `memory_revisions` table captures the previous
  `body`, `tags`, and `importance` every time a memory is updated (manual,
  upsert, or fuzzy merge). New `memory_history` MCP tool (and
  `memorex history <id>` CLI command) lists recent revisions with reason
  codes (`manual-update`, `upsert`, `fuzzy-merge`).

### Changed

- `install.sh` now also wires the `SubagentStop` hook.
- MCP server moved to `src/mcp.ts`; `src/index.ts` is now a dispatcher.

## [0.3.0] - 2026-04-21

### Fixed

- **FTS5 BM25 ranking bug**: `scoreMemory` compared `ftsRank > 0` but SQLite BM25
  returns negative values. As a result every FTS match received a constant
  `relevance = 0.1` and the "relevance-scored search" was effectively
  `importance × recency × popularity`. Now correctly uses the magnitude of
  negative BM25 ranks, normalized against `SCORING.FTS_RANK_NORM`.
- **Lock contention silently ate saves**: `canSave()` returned false on a single
  `mkdir` failure. Now retries with bounded exponential backoff
  (`SESSION.LOCK_RETRY_ATTEMPTS`).
- **Fuzzy dedup collapsed distinct memories**: 0.7 word-overlap over the input
  title merged "Fixed login bug" and "Fixed logout bug". Threshold raised to
  0.85 using containment (`overlap / min(a, b)`) and an additional Jaccard body
  similarity check (`FUZZY_BODY_SIMILARITY_MIN`) is required before updating.

### Added

- **`UserPromptSubmit` hook**: auto-injects the top-3 relevant memories into
  every prompt under a 500-token budget, so Claude no longer has to remember to
  call `memory_search`. Zero cost when nothing matches.
- **`PreCompact` hook**: snapshots recent user prompts and files touched into
  a 7-day project memory before context compaction so long sessions don't lose
  state.
- **Knowledge graph (`memory_links` table)**: every save auto-links to the top
  FTS matches via position-weighted strength. New `memory_related` MCP tool
  lists 1-hop neighbors. `ON DELETE CASCADE` keeps the graph clean.
- **Git-root project detection**: `getProjectRoot()` resolves via
  `git rev-parse --show-toplevel` so memories bind to the repo, not a
  sub-directory cwd. Cached per process.
- **Structured `memory_stats` output**: `format: 'json'` returns a typed
  overview (total, pinned, by_type, capacity, session) for machine consumers.
- **Actionable save-limit messaging**: when rate-limited, `memory_save` lists
  the three lowest-scoring memories as prune candidates.

### Changed

- BM25 field weights: title ×10, tags ×3, body ×1 (`SCORING.BM25_WEIGHTS`).
  Exact-title hits now dominate search, which matches user intent.
- `LIMITS.MAX_BODY_LENGTH` raised `1500 → 4000` chars. Display cap unchanged
  at 500 so search results stay token-cheap.
- `install.sh` now wires `UserPromptSubmit` and `PreCompact` hooks alongside
  the existing `SessionStart` / `Stop` hooks.

### Security

- `getProjectRoot()` validates git output for null bytes, newlines, and
  reasonable length before trusting it (does NOT force-scope to `$HOME`, which
  would break repos in system paths).

## [0.2.0] - 2025 pre-release — infrastructure pass

### Added

- Comprehensive test suite with Vitest and coverage reporting
- ESLint 9 flat configuration with TypeScript strict rules
- Prettier for consistent code formatting
- Pre-commit hooks with Husky and lint-staged
- Structured logging system for debugging
- GitHub Actions CI/CD pipeline for testing and releases
- Reorganized project structure with clear separation of concerns

### Changed

- Improved type safety by removing all `any` casts
- Enhanced error handling with contextual logging
- Updated `.gitignore` with comprehensive exclusions
- Centralized all magic numbers in config.ts (TIME, LIMITS, SCORING, DEFAULT_TTL_DAYS, etc.)
- Refactored formatMemoryForContext to use compact output format
- Refactored getStats to use compact output format
- Enhanced Logger with close() method and process signal handlers
- Improved database error handling with descriptive messages

### Security

- Added input validation for project paths
- Improved error handling with cause preservation

### Fixed

- Corrected hook file names in install.sh (start.js/end.js)
- Fixed TypeScript configuration for ESLint

## [0.1.0] - 2024-04-08

### Added

- Initial release of Memorex MCP server
- SQLite + FTS5 for fast full-text search
- Decay scoring algorithm (project: 14d, feedback: 90d, user: 180d, reference: 365d)
- Token budget enforcement for search results
- Anti-bloat guards (200 memory cap, 5 saves/session)
- Fuzzy deduplication
- Auto-prune on session end
- 4 memory types: user, project, feedback, reference
- Session hooks for start/end

[unreleased]: https://github.com/mitre88/memorex/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/mitre88/memorex/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mitre88/memorex/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/mitre88/memorex/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/mitre88/memorex/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mitre88/memorex/compare/v0.1.0...v0.3.0
[0.1.0]: https://github.com/mitre88/memorex/releases/tag/v0.1.0
