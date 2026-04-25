#!/usr/bin/env node
/**
 * Entry point — dispatches to either the CLI or the MCP stdio server.
 *
 * When invoked with any argv (e.g. `memorex ls`, `memorex search foo`) we run
 * the CLI. When invoked with no arguments (how Claude Code launches MCP
 * servers over stdio) or with `--mcp`, we boot the MCP server.
 */
import { runCli } from './cli.js';
import { runMcpServer } from './mcp.js';

const argv = process.argv.slice(2);
const first = argv[0];

async function main(): Promise<void> {
  if (argv.length === 0 || first === '--mcp') {
    await runMcpServer();
    return;
  }
  const code = await runCli(argv);
  process.exit(code);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`memorex: ${msg}\n`);
  process.exit(1);
});
