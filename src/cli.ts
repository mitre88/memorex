/**
 * CLI surface for memorex — lets users inspect and manage ~/.memorex/memories.db
 * without opening Claude Code. Mirrors the MCP tools for parity but returns
 * plain-text output shaped for terminals.
 *
 * Commands:
 *   memorex ls [--type T] [--project P] [--limit N]
 *   memorex search <query> [--limit N]
 *   memorex show <id>
 *   memorex pin <id> | unpin <id>
 *   memorex rm <id>
 *   memorex stats [--json]
 *   memorex history <id> [--limit N]
 *   memorex prune [--yes]
 *   memorex backup [path]
 *   memorex import --from claude-md|obsidian|engram <path>
 *   memorex version
 *   memorex help
 */
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getDb } from './db/index.js';
import { CONFIG, PATHS } from './utils/config.js';
import {
  searchMemories,
  getStats,
  deleteMemory,
  updateMemory,
  pruneMemories,
  getHistory,
} from './tools/index.js';
import type { Memory } from './types/scoring.js';
import { runImport, type ImportSource } from './importers.js';

const VERSION = '0.4.1';

type Parsed = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function help(): string {
  return [
    `memorex ${VERSION} — passive memory for Claude Code`,
    '',
    'Usage:',
    '  memorex                       start MCP stdio server (default)',
    '  memorex ls [--type T] [--project P] [--limit N]',
    '  memorex search <query> [--limit N]',
    '  memorex show <id>',
    '  memorex pin <id>',
    '  memorex unpin <id>',
    '  memorex rm <id>',
    '  memorex stats [--json]',
    '  memorex history <id> [--limit N]',
    '  memorex prune [--yes]',
    '  memorex backup [path]',
    '  memorex import --from claude-md|obsidian|engram <path>',
    '  memorex version',
    '  memorex help',
    '',
    `Storage: ${PATHS.DB_FILE}`,
  ].join('\n');
}

function cmdLs(flags: Record<string, string | boolean>): string {
  const db = getDb();
  try {
    const where: string[] = ['(expires_at IS NULL OR expires_at > ?)'];
    const now = Math.floor(Date.now() / 1000);
    const params: (string | number)[] = [now];
    if (typeof flags.type === 'string') {
      where.push('type = ?');
      params.push(flags.type);
    }
    if (typeof flags.project === 'string') {
      where.push('project = ?');
      params.push(flags.project);
    }
    const limit = Number(flags.limit ?? 30);

    const rows = db
      .prepare(
        `SELECT id, type, title, importance, pinned, accessed_at
         FROM memories WHERE ${where.join(' AND ')}
         ORDER BY pinned DESC, accessed_at DESC LIMIT ?`
      )
      .all(...params, limit) as Pick<
      Memory,
      'id' | 'type' | 'title' | 'importance' | 'pinned' | 'accessed_at'
    >[];

    if (rows.length === 0) return 'No memories.';

    const lines = rows.map((r) => {
      const pin = r.pinned ? 'P' : ' ';
      const age = Math.round((now - r.accessed_at) / 86400);
      return `${pin} #${r.id.toString().padStart(4)} [${r.type[0].toUpperCase()}] imp=${r.importance.toFixed(2)} ${age}d  ${r.title}`;
    });
    return lines.join('\n');
  } finally {
    db.close();
  }
}

function cmdSearch(query: string, flags: Record<string, string | boolean>): string {
  if (!query) return 'Error: search requires a query. Run `memorex help`.';
  const db = getDb();
  try {
    return searchMemories(db, {
      query,
      token_budget: Number(flags.limit ?? 2000),
      min_score: 0.01,
    } as Parameters<typeof searchMemories>[1]);
  } finally {
    db.close();
  }
}

function cmdShow(rawId: string): string {
  const id = Number(rawId);
  if (!Number.isFinite(id)) return `Error: invalid id "${rawId}".`;
  const db = getDb();
  try {
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined;
    if (!row) return `Memory #${id} not found.`;
    const tags = (JSON.parse(row.tags || '[]') as string[]).join(', ') || '—';
    const created = new Date(row.created_at * 1000).toISOString();
    const accessed = new Date(row.accessed_at * 1000).toISOString();
    const expires = row.expires_at ? new Date(row.expires_at * 1000).toISOString() : '—';
    return [
      `#${row.id} [${row.type}] ${row.title}`,
      `  pinned=${row.pinned ? 'yes' : 'no'}  imp=${row.importance}  access=${row.access_count}`,
      `  project=${row.project ?? '—'}`,
      `  tags=${tags}`,
      `  created=${created}`,
      `  accessed=${accessed}`,
      `  expires=${expires}`,
      '',
      row.body,
    ].join('\n');
  } finally {
    db.close();
  }
}

function cmdPin(rawId: string, pinned: boolean): string {
  const id = Number(rawId);
  if (!Number.isFinite(id)) return `Error: invalid id "${rawId}".`;
  const db = getDb();
  try {
    return updateMemory(db, { id, pinned });
  } finally {
    db.close();
  }
}

function cmdRm(rawId: string): string {
  const id = Number(rawId);
  if (!Number.isFinite(id)) return `Error: invalid id "${rawId}".`;
  const db = getDb();
  try {
    return deleteMemory(db, { id });
  } finally {
    db.close();
  }
}

function cmdStats(flags: Record<string, string | boolean>): string {
  const db = getDb();
  try {
    return getStats(db, { format: flags.json ? 'json' : 'compact' });
  } finally {
    db.close();
  }
}

function cmdHistory(rawId: string, flags: Record<string, string | boolean>): string {
  const id = Number(rawId);
  if (!Number.isFinite(id)) return `Error: invalid id "${rawId}".`;
  const db = getDb();
  try {
    return getHistory(db, { id, limit: Number(flags.limit ?? 10) });
  } finally {
    db.close();
  }
}

function cmdPrune(flags: Record<string, string | boolean>): string {
  const db = getDb();
  try {
    return pruneMemories(db, {
      dry_run: !flags.yes,
      max_age_days: Number(flags['max-age-days'] ?? 90),
    });
  } finally {
    db.close();
  }
}

function cmdBackup(dest?: string): string {
  if (!existsSync(PATHS.DB_FILE)) return 'Nothing to back up (no database yet).';
  const backupsDir = join(PATHS.DB_DIR, 'backups');
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const target = dest ?? join(backupsDir, `memories-${ts}.db`);
  copyFileSync(PATHS.DB_FILE, target);
  return `Backup written: ${target}`;
}

function cmdImport(flags: Record<string, string | boolean>, positional: string[]): string {
  const from = typeof flags.from === 'string' ? flags.from : '';
  const path = positional[0];
  if (!from || !path) {
    return 'Usage: memorex import --from claude-md|obsidian|engram <path>';
  }
  if (from !== 'claude-md' && from !== 'obsidian' && from !== 'engram') {
    return `Error: unknown source "${from}". Use claude-md, obsidian, or engram.`;
  }
  const db = getDb();
  try {
    const result = runImport(db, from as ImportSource, path);
    return `Imported ${result.imported} memor${result.imported === 1 ? 'y' : 'ies'} from ${from} (${result.skipped} skipped).`;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  } finally {
    db.close();
  }
}

export function runCli(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);

  let out = '';
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      out = help();
      break;
    case 'version':
    case '--version':
    case '-v':
      out = VERSION;
      break;
    case 'ls':
    case 'list':
      out = cmdLs(flags);
      break;
    case 'search':
      out = cmdSearch(positional.join(' '), flags);
      break;
    case 'show':
      out = cmdShow(positional[0] ?? '');
      break;
    case 'pin':
      out = cmdPin(positional[0] ?? '', true);
      break;
    case 'unpin':
      out = cmdPin(positional[0] ?? '', false);
      break;
    case 'rm':
    case 'delete':
      out = cmdRm(positional[0] ?? '');
      break;
    case 'stats':
      out = cmdStats(flags);
      break;
    case 'history':
      out = cmdHistory(positional[0] ?? '', flags);
      break;
    case 'prune':
      out = cmdPrune(flags);
      break;
    case 'backup':
      out = cmdBackup(positional[0]);
      break;
    case 'import':
      out = cmdImport(flags, positional);
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${help()}\n`);
      return 1;
  }

  process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  if (cmd === 'stats' && !flags.json) {
    process.stdout.write(`db: ${PATHS.DB_FILE}\ncap: ${CONFIG.MAX_MEMORIES}\n`);
  }
  return 0;
}
