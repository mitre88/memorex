# memorex

Persistent memory and token savings for Claude Code.

An MCP server that gives Claude Code long-term memory across sessions — stored in SQLite with full-text search, scored by relevance decay, and bounded by hard token budgets.

## Install

```bash
git clone https://github.com/mitre88/memorex
cd memorex
chmod +x install.sh
./install.sh
```

Restart Claude Code after installing.

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

- **SQLite + FTS5** — fast full-text search, zero external APIs
- **Decay scoring** — memories fade by type (project: 14d, feedback: 90d, user: 180d, reference: 365d)
- **Token budgets** — search results capped to a configurable token limit, most relevant first
- **Anti-bloat guards** — hard cap of 200 memories, 5 saves per session, fuzzy dedup, auto-prune on session end
- **4 memory types**: `user`, `project`, `feedback`, `reference`

## MCP Tools

| Tool            | Description                                           |
| --------------- | ----------------------------------------------------- |
| `memory_search` | Find relevant memories for current context            |
| `memory_save`   | Save or update a memory (with dedup + session limits) |
| `memory_prune`  | Remove expired or low-relevance memories              |
| `memory_stats`  | Storage overview and session budget                   |

## Session Hooks

| Hook           | When                | What                                                 |
| -------------- | ------------------- | ---------------------------------------------------- |
| `SessionStart` | Opening Claude Code | Resets session counter, prints 1-line status         |
| `Stop`         | Closing Claude Code | Silently prunes expired/cold memories (0 token cost) |

## Limits

| Limit               | Value                                   |
| ------------------- | --------------------------------------- |
| Max memories        | 200 (evicts lowest-scoring on overflow) |
| Saves per session   | 5                                       |
| Body size (save)    | 1500 chars                              |
| Body size (display) | 500 chars                               |
| Search token budget | 2000 (configurable)                     |
| Project memory TTL  | 30 days default                         |

## Storage

All data stored locally at `~/.memorex/memories.db`.

## License

MIT
