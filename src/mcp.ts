/**
 * MCP stdio server entry point.
 *
 * Kept separate from src/index.ts so the same binary can dispatch to either
 * the CLI (any argv) or the MCP server (no argv / --mcp).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb } from './db/index.js';
import {
  SearchInput,
  SaveInput,
  PruneInput,
  StatsInput,
  UpdateInput,
  DeleteInput,
  ContextInput,
  ExportInput,
  RelatedInput,
  HistoryInput,
  MergeInput,
  type SearchInputType,
  type SaveInputType,
  type PruneInputType,
  type StatsInputType,
  type UpdateInputType,
  type DeleteInputType,
  type ContextInputType,
  type ExportInputType,
  type RelatedInputType,
  type HistoryInputType,
  type MergeInputType,
  searchMemoriesHybrid,
  saveMemory,
  embedAndStoreMemory,
  pruneMemories,
  getStats,
  updateMemory,
  deleteMemory,
  getContext,
  exportMemories,
  getRelated,
  getHistory,
  mergeMemories,
} from './tools/index.js';
import { EMBEDDINGS_ENABLED } from './embeddings.js';

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'memorex',
    version: '0.9.0',
  });

  const db = getDb();

  server.tool(
    'memory_search',
    'Find relevant memories within token budget',
    SearchInput.shape,
    async (input: SearchInputType) => ({
      // Hybrid path falls back to plain FTS internally when embeddings are
      // disabled or unavailable, so it's safe to always go through it.
      content: [{ type: 'text', text: await searchMemoriesHybrid(db, input) }],
    })
  );

  server.tool(
    'memory_save',
    'Save or update a memory (deduped)',
    SaveInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await
    async (input: SaveInputType) => {
      const text = saveMemory(db, input);
      // Fire-and-forget embedding compute. We pull the new id out of the
      // success message ("Saved memory #42…"). No await — the user gets the
      // save confirmation immediately, the embedding fills in within a few
      // hundred ms in the background.
      if (EMBEDDINGS_ENABLED) {
        const m = text.match(/#(\d+)/);
        if (m) {
          const id = Number(m[1]);
          void embedAndStoreMemory(db, id).catch(() => {
            /* analytics-style: never break the user's save */
          });
        }
      }
      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'memory_prune',
    'Remove expired/low-relevance memories',
    PruneInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await
    async (input: PruneInputType) => ({
      content: [{ type: 'text', text: pruneMemories(db, input) }],
    })
  );

  server.tool(
    'memory_stats',
    'Memory count and session budget',
    StatsInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await
    async (input: StatsInputType) => ({
      content: [{ type: 'text', text: getStats(db, input) }],
    })
  );

  server.tool(
    'memory_update',
    'Update a memory by ID',
    UpdateInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await
    async (input: UpdateInputType) => ({
      content: [{ type: 'text', text: updateMemory(db, input) }],
    })
  );

  server.tool(
    'memory_delete',
    'Delete a memory by ID',
    DeleteInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await
    async (input: DeleteInputType) => ({
      content: [{ type: 'text', text: deleteMemory(db, input) }],
    })
  );

  server.tool(
    'memory_context',
    'Auto-context: top memories for current project',
    ContextInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await
    async (input: ContextInputType) => ({
      content: [{ type: 'text', text: getContext(db, input) }],
    })
  );

  server.tool(
    'memory_export',
    'Export memories as JSON or markdown',
    ExportInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await
    async (input: ExportInputType) => ({
      content: [{ type: 'text', text: exportMemories(db, input) }],
    })
  );

  server.tool(
    'memory_related',
    'List neighbors of a memory in the knowledge graph',
    RelatedInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await
    async (input: RelatedInputType) => ({
      content: [{ type: 'text', text: getRelated(db, input) }],
    })
  );

  server.tool(
    'memory_history',
    'Show revision history of a memory (body/tags/importance over time)',
    HistoryInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await
    async (input: HistoryInputType) => ({
      content: [{ type: 'text', text: getHistory(db, input) }],
    })
  );

  server.tool(
    'memory_merge',
    'Merge merge_id into keep_id (concat bodies, union tags, max importance, delete merge_id)',
    MergeInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await
    async (input: MergeInputType) => ({
      content: [{ type: 'text', text: mergeMemories(db, input) }],
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
