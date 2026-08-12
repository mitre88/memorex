# Contributing to memorex

Thanks for your interest. memorex is a small project with a tight scope —
passive memory for Claude Code — and contributions are welcome as long as
they fit that scope.

## Quick start

```bash
git clone https://github.com/mitre88/memorex
cd memorex
npm install
npm test       # 89 tests
npm run build  # tsc + esbuild bundle hooks
```

## Project layout

```
src/
├── __tests__/          Vitest test suite
├── db/                 SQLite schema + migrations (versioned via PRAGMA user_version)
├── hooks/              UserPromptSubmit, Stop, PreCompact, SessionStart, SubagentStop
├── tools/              MCP tool implementations (search, save, prune, ...)
├── types/              Shared types (scoring, Memory)
├── utils/              config, logging, session lock, security, project root
├── analytics.ts        memorex gain (inject_events aggregation)
├── doctor.ts           memorex doctor (health checks + exit codes)
├── embeddings.ts       Local sentence embeddings (all-MiniLM-L6-v2 via @xenova/transformers, optional)
├── importers.ts        memorex import --from claude-md|obsidian|engram
├── cli.ts              CLI dispatcher
├── mcp.ts              MCP stdio server
└── index.ts            Entry point — argv split: CLI vs MCP
```

## Conventions

- **TypeScript strict** — no `any`, narrow types, prefer `unknown` over `any` for I/O boundaries
- **Functional style** — prefer pure functions over classes for tools
- **Comments explain WHY**, not what — readers can read code; they need to know the reason
- **Schema migrations are append-only** — bump `SCHEMA_VERSION` in `src/db/index.ts`,
  add a `migrateVN(db)` function, run inside the existing transaction. Never edit a previous migration.
- **Hooks must fail-silent** — wrap everything in try/catch, never block the user's prompt
- **Tests required** — new MCP tools, CLI commands, scoring changes, and migrations all need at least
  one test in `src/__tests__/`. Use the temp-DB pattern from `tools.test.ts` for DB tests.

## Running the linter and formatter

```bash
npm run lint            # eslint src/
npm run lint:fix        # auto-fix
npm run format          # prettier --write src/
npm run format:check    # CI-style check
npm run typecheck       # tsc --noEmit
```

Husky + lint-staged run lint and format on commit, so most issues are caught
automatically.

## Branching and PRs

- Branch from `main`. Use `feat/` `fix/` `docs/` `chore/` prefixes.
- One change per PR. Keep diffs reviewable.
- PR title in conventional commit style: `feat(scope): summary`, `fix(...): ...`, `docs(...): ...`.
- The PR template asks for: motivation, what changed, how to verify. Fill all three.
- All tests must pass and CI must be green before review.

## What's in scope

- Memory storage, scoring, decay, and search behavior
- Hook integration with Claude Code
- CLI tooling for inspecting and managing memories
- Performance and observability (`gain`, `doctor`)
- New importers (CLAUDE.md, Obsidian, Engram, etc.)

## What's out of scope

- Generic note-taking app features. memorex is a memory layer for an AI coding assistant —
  not a Notion clone. If a feature isn't shaped by the assistant's read pattern, it probably
  doesn't belong here.
- Cloud sync / SaaS. memorex is local-first by design. A user-driven export/import is fine;
  a hosted server is not.
- Adding heavy dependencies to the core. Keep `dependencies` minimal. Anything optional
  (like `@xenova/transformers` for embeddings) goes in `optionalDependencies`.

## Reporting bugs and security issues

- **Bugs**: open a GitHub issue using the bug report template. Include `memorex doctor` output.
- **Security**: see [SECURITY.md](SECURITY.md). Do not file public issues for vulnerabilities.

## License

By contributing you agree that your contributions are licensed under the MIT License.
