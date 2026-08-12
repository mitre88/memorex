# memorex Progress

## Current Handoff

- Date: 2026-05-18
- Focus: Minimal harness adoption for agent-readable repo work.
- Status: Complete.

## Last Verified

- Environment used: `PATH="/opt/homebrew/opt/node@24/bin:$PATH"` with Node v24.15.0.
- `npm test` via Vitest forks: passed, 10 files and 96 tests after `npm rebuild better-sqlite3` for ABI 137.
- `npx prettier --write` on the 8 files that failed `format:check`.
- Local `tsc --noEmit` hangs on this iCloud Desktop checkout (node_modules resolution). CI on Ubuntu remains the typecheck source of truth.

## Open Blockers

- Homebrew `node@22` is broken locally (`libsimdutf.33.dylib` missing). Use `node@24` unless the local Node install is repaired.
- `better-sqlite3` must be rebuilt when switching Node major versions (ABI 137 for Node 24).

## Notes

- The harness is documentation and workflow metadata only. It must not change CLI, MCP, hook, database, or package runtime behavior.
