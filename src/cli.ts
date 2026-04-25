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
  mergeMemories,
  rebuildEmbeddings,
  embeddingStatus,
} from './tools/index.js';
import type { Memory } from './types/scoring.js';
import { runImport } from './importers.js';
import {
  getGainSummary,
  getGainHistory,
  formatGainSummary,
  formatGainHistory,
} from './analytics.js';
import { runDoctor, formatDoctorReport, doctorExitCode } from './doctor.js';

const VERSION = '0.9.0';

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
    '  memorex merge <keep_id> <merge_id>',
    '  memorex gain [--days N] [--project P] [--history] [--json]',
    '  memorex doctor [--json]',
    '  memorex embed-status [--json]',
    '  memorex embed-rebuild [--all]',
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
    });
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

function cmdMerge(positional: string[]): string {
  const keep = Number(positional[0]);
  const merge = Number(positional[1]);
  if (!Number.isFinite(keep) || !Number.isFinite(merge)) {
    return 'Usage: memorex merge <keep_id> <merge_id>';
  }
  const db = getDb();
  try {
    return mergeMemories(db, { keep_id: keep, merge_id: merge, separator: '\n\n---\n\n' });
  } finally {
    db.close();
  }
}

function cmdGain(flags: Record<string, string | boolean>): string {
  const opts = {
    days: typeof flags.days === 'string' ? Number(flags.days) : undefined,
    project: typeof flags.project === 'string' ? flags.project : undefined,
  };
  const db = getDb();
  try {
    if (flags.history) {
      const rows = getGainHistory(db, opts);
      return flags.json ? JSON.stringify(rows, null, 2) : formatGainHistory(rows);
    }
    const summary = getGainSummary(db, opts);
    return flags.json ? JSON.stringify(summary, null, 2) : formatGainSummary(summary);
  } finally {
    db.close();
  }
}

/**
 * Doctor returns a tuple of [text, exitCode]. Most CLI commands return only
 * text and rely on the dispatcher's default exit code 0; doctor is special
 * because it's meant to be scriptable in CI / install validators.
 */
function cmdEmbedStatus(flags: Record<string, string | boolean>): string {
  const db = getDb();
  try {
    const s = embeddingStatus(db);
    if (flags.json) return JSON.stringify(s, null, 2);
    const pct = s.total > 0 ? ((s.with_embedding / s.total) * 100).toFixed(0) : '0';
    return [
      `Embeddings: ${s.with_embedding}/${s.total} (${pct}%)  missing: ${s.without_embedding}`,
      `Enabled: ${s.enabled ? 'yes' : 'no (set MEMOREX_EMBEDDINGS=1)'}`,
      `Semantic weight: ${s.semantic_weight}`,
    ].join('\n');
  } finally {
    db.close();
  }
}

async function cmdEmbedRebuild(flags: Record<string, string | boolean>): Promise<string> {
  // Soft reminder if the user hasn't enabled embeddings — the rebuild will
  // no-op silently otherwise (getEmbedder returns null) and that's confusing.
  if (process.env.MEMOREX_EMBEDDINGS !== '1') {
    return (
      'Error: MEMOREX_EMBEDDINGS=1 not set. Enable embeddings first:\n' +
      '  export MEMOREX_EMBEDDINGS=1\n' +
      '  memorex embed-rebuild'
    );
  }
  const db = getDb();
  try {
    const onlyMissing = !flags.all;
    process.stdout.write(`Rebuilding embeddings (${onlyMissing ? 'missing only' : 'all'})…\n`);
    const t0 = Date.now();
    const result = await rebuildEmbeddings(db, { onlyMissing });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    return `Done in ${elapsed}s — ${result.done} embedded, ${result.failed} failed, ${result.skipped} skipped (already had one).`;
  } finally {
    db.close();
  }
}

function cmdDoctor(flags: Record<string, string | boolean>): { out: string; code: number } {
  // Open DB if it exists; pass null otherwise so doctor can still report.
  let db: ReturnType<typeof getDb> | null = null;
  try {
    if (existsSync(PATHS.DB_FILE)) db = getDb();
  } catch {
    db = null;
  }
  try {
    const report = runDoctor(db);
    if (flags.json) {
      return { out: JSON.stringify(report, null, 2), code: doctorExitCode(report) };
    }
    return { out: formatDoctorReport(report), code: doctorExitCode(report) };
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
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
  // After the guard above, `from` narrows to ImportSource — no cast needed.
  const db = getDb();
  try {
    const result = runImport(db, from, path);
    return `Imported ${result.imported} memor${result.imported === 1 ? 'y' : 'ies'} from ${from} (${result.skipped} skipped).`;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  } finally {
    db.close();
  }
}

export async function runCli(argv: string[]): Promise<number> {
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
    case 'merge':
      out = cmdMerge(positional);
      break;
    case 'gain':
      out = cmdGain(flags);
      break;
    case 'doctor': {
      // Doctor short-circuits the standard dispatch because it owns its
      // exit code: 0 = clean, 1 = warnings, 2 = failures.
      const r = cmdDoctor(flags);
      process.stdout.write(r.out.endsWith('\n') ? r.out : `${r.out}\n`);
      return r.code;
    }
    case 'embed-status':
      out = cmdEmbedStatus(flags);
      break;
    case 'embed-rebuild':
      out = await cmdEmbedRebuild(flags);
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
