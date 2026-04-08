#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb } from './db.js';
import {
  SearchInput, SaveInput, PruneInput, StatsInput,
  searchMemories, saveMemory, pruneMemories, getStats,
} from './tools.js';

const server = new McpServer({
  name: 'memorex',
  version: '0.1.0',
});

const db = getDb();

server.tool(
  'memory_search',
  'Search memories relevant to current context. Returns scored memories within token budget.',
  SearchInput.shape,
  async (input) => ({
    content: [{ type: 'text', text: searchMemories(db, input as any) }],
  })
);

server.tool(
  'memory_save',
  'Save a new memory or update existing one with same title+type.',
  SaveInput.shape,
  async (input) => ({
    content: [{ type: 'text', text: saveMemory(db, input as any) }],
  })
);

server.tool(
  'memory_prune',
  'Remove low-relevance, expired, or old memories to keep storage clean.',
  PruneInput.shape,
  async (input) => ({
    content: [{ type: 'text', text: pruneMemories(db, input as any) }],
  })
);

server.tool(
  'memory_stats',
  'Show memory count by type and storage stats.',
  StatsInput.shape,
  async (input) => ({
    content: [{ type: 'text', text: getStats(db, input as any) }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
