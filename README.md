# memorex

Passive persistent memory for Claude Code.

An MCP server + hook set that gives Claude Code long-term memory across sessions — stored in SQLite with full-text search, scored by BM25-weighted relevance decay, bounded by hard token budgets, and **auto-injected on every prompt** without Claude needing to call a tool.

## Install

```bash
git clone https://github.com/mitre88/memorex
cd memorex
chmod +x install.sh
./install.sh
```

Restart Claude Code after installing.

## CLI

The same `memorex` binary ships a CLI so you can inspect and manage the local database without opening Claude Code:

```bash
memorex ls                      # list recent memories
memorex search "auth"           # FTS search
memorex show 42                 # print a single memory
memorex pin 42                  # pin / unpin so decay doesn't touch it
memorex rm 42                   # delete a memory
memorex history 42              # revision history for #42
memorex stats                   # compact one-liner (add --json for JSON)
memorex prune --yes             # really delete cold memories
memorex backup                  # copy the db into ~/.memorex/backups
memorex import --from claude-md ~/.claude/CLAUDE.md
memorex import --from obsidian  ~/Documents/Obsidian\ Vault
memorex import --from engram    ~/engram-dump.json
memorex gain                    # last-7d analytics: inject rate, tokens, top memories
memorex gain --history          # per-day inject/token trend
memorex gain --json             # machine-readable summary
memorex doctor                  # health check (DB, schema, hooks, capacity)
memorex doctor --json           # scriptable diagnostics; exit 0/1/2 by worst level
memorex help
```

Calling `memorex` with no arguments still starts the MCP stdio server (that's how Claude Code launches it).

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Build
npm run build

# Lint
npm run lint

# Format
npm run format
```

## Project Structure

```
src/
├── __tests__/          # Test suite (Vitest)
├── db/                 # Database layer (SQLite + FTS5)
├── hooks/              # Session lifecycle hooks
├── tools/              # MCP tool implementations
├── types/              # Shared TypeScript types
└── utils/              # Utilities (config, logging, session, security)
```

## How it works

- **SQLite + FTS5 BM25** — fast full-text search, title weighted 10× over body, zero external APIs
- **Decay scoring** — memories fade by type (project: 14d, feedback: 90d, user: 180d, reference: 365d)
- **Token budgets** — search results capped to a configurable token limit, most relevant first
- **Passive auto-inject** — a `UserPromptSubmit` hook prepends top-3 relevant memories to every prompt without Claude calling a tool
- **Compaction survival** — a `PreCompact` hook snapshots recent prompts + files touched into a 7-day project memory so long sessions don't go amnesic
- **Knowledge graph** — every save auto-links to related memories; `memory_related` traverses neighbors
- **Git-root aware** — project memories bind to `git rev-parse --show-toplevel`, not the current working dir, so sub-directory work doesn't fragment memory
- **Anti-bloat guards** — hard cap of 200 memories, 5 saves per session, containment-based fuzzy dedup, auto-prune on session end
- **Observability** — every prompt is logged to an `inject_events` table (success or skip); `memorex gain` reports inject rate, tokens injected, top memories shown, hit-ratio estimate
- **Diagnostics** — `memorex doctor` validates DB integrity, schema version, FTS index sync, file permissions, hook wiring, and capacity headroom
- **4 memory types**: `user`, `project`, `feedback`, `reference`

## MCP Tools

| Tool             | Description                                             |
| ---------------- | ------------------------------------------------------- |
| `memory_search`  | Find relevant memories for current context              |
| `memory_save`    | Save or update a memory (with dedup + session limits)   |
| `memory_prune`   | Remove expired or low-relevance memories                |
| `memory_stats`   | Storage overview and session budget (compact or JSON)   |
| `memory_update`  | Update a memory by ID                                   |
| `memory_delete`  | Delete a memory by ID                                   |
| `memory_context` | Auto-context: top memories for current git-root project |
| `memory_export`  | Export memories as JSON or markdown                     |
| `memory_related` | List knowledge-graph neighbors of a memory              |
| `memory_history` | Show revision history of a memory over time             |

## Session Hooks

| Hook               | When                | What                                                                    |
| ------------------ | ------------------- | ----------------------------------------------------------------------- |
| `SessionStart`     | Opening Claude Code | Resets session counter, prints 1-line status                            |
| `UserPromptSubmit` | Every user prompt   | Auto-injects top-3 relevant memories (budget 500 tokens, zero if empty) |
| `PreCompact`       | Before compaction   | Snapshots recent prompts + files into a 7-day memory                    |
| `Stop`             | Closing Claude Code | Silently prunes expired/cold memories (0 token cost)                    |
| `SubagentStop`     | Sub-agent finishes  | Saves the sub-agent's final result as a `feedback` memory (30-day TTL)  |

## Limits

| Limit                  | Value                                    |
| ---------------------- | ---------------------------------------- |
| Max memories           | 200 (evicts lowest-scoring on overflow)  |
| Saves per session      | 5                                        |
| Body size (save)       | 4000 chars                               |
| Body size (display)    | 500 chars                                |
| Search token budget    | 2000 (configurable)                      |
| Auto-inject budget     | 500 tokens (via `MEMOREX_INJECT_BUDGET`) |
| Project memory TTL     | 30 days default                          |
| Pre-compact memory TTL | 7 days                                   |

## Storage

All data stored locally at `~/.memorex/memories.db`.

## License

MIT
