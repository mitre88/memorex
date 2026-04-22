# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [Unreleased]

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

[unreleased]: https://github.com/mitre88/memorex/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/mitre88/memorex/compare/v0.1.0...v0.3.0
[0.1.0]: https://github.com/mitre88/memorex/releases/tag/v0.1.0
