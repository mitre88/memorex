#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb } from './db/index.js';
import {
  SearchInput,
  SaveInput,
  PruneInput,
  StatsInput,
  type SearchInputType,
  type SaveInputType,
  type PruneInputType,
  type StatsInputType,
  searchMemories,
  saveMemory,
  pruneMemories,
  getStats,
} from './tools/index.js';

const server = new McpServer({
  name: 'memorex',
  version: '0.1.0',
});

const db = getDb();

server.tool(
  'memory_search',
  'Search memories relevant to current context. Returns scored memories within token budget.',
  SearchInput.shape,
  // eslint-disable-next-line @typescript-eslint/require-await
  async (input: SearchInputType) => ({
    content: [{ type: 'text', text: searchMemories(db, input) }],
  })
);

server.tool(
  'memory_save',
  'Save a new memory or update existing one with same title+type.',
  SaveInput.shape,
  // eslint-disable-next-line @typescript-eslint/require-await
  async (input: SaveInputType) => ({
    content: [{ type: 'text', text: saveMemory(db, input) }],
  })
);

server.tool(
  'memory_prune',
  'Remove low-relevance, expired, or old memories to keep storage clean.',
  PruneInput.shape,
  // eslint-disable-next-line @typescript-eslint/require-await
  async (input: PruneInputType) => ({
    content: [{ type: 'text', text: pruneMemories(db, input) }],
  })
);

server.tool(
  'memory_stats',
  'Show memory count by type and storage stats.',
  StatsInput.shape,
  // eslint-disable-next-line @typescript-eslint/require-await
  async (input: StatsInputType) => ({
    content: [{ type: 'text', text: getStats(db, input) }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
