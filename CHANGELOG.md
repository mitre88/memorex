# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[unreleased]: https://github.com/mitre88/memorex/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mitre88/memorex/releases/tag/v0.1.0
