/**
 * `memorex doctor` — diagnostics and health check.
 *
 * Runs a battery of fast checks against the local install and reports each as
 * OK / WARN / FAIL with a concrete fix when something is wrong. Returns an
 * exit code so the CLI can fail scriptable invocations.
 *
 * What we check, in order:
 *
 *   1. Database file exists and is readable
 *   2. Permissions on DB / SESSION files (should be 0600)
 *   3. Schema version matches the binary's expected SCHEMA_VERSION
 *   4. SQLite `PRAGMA integrity_check` clean
 *   5. FTS index in sync (count(memories) == count(memories_fts))
 *   6. ~/.claude/settings.json has all five memorex hooks wired
 *   7. Each wired hook script file exists on disk
 *   8. Memory capacity headroom (warn at >90% of MAX_MEMORIES)
 *   9. Recent inject activity (warn if zero events in 7 days while DB has memories)
 *
 * Each check is independent — one FAIL doesn't short-circuit the rest. Doctor
 * should give the user the full picture of what's wrong in one pass.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { PATHS, LIMITS, TIME } from './utils/config.js';

export type CheckLevel = 'OK' | 'WARN' | 'FAIL';

export interface CheckResult {
  level: CheckLevel;
  name: string;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  results: CheckResult[];
  summary: { ok: number; warn: number; fail: number };
}

/** Schema version this binary was built against — kept in sync with src/db/index.ts. */
const EXPECTED_SCHEMA = 7;

const REQUIRED_HOOKS = [
  { event: 'SessionStart', script: 'dist/hooks/start.js' },
  { event: 'Stop', script: 'dist/hooks/end.js' },
  { event: 'UserPromptSubmit', script: 'dist/hooks/prompt.js' },
  { event: 'PreCompact', script: 'dist/hooks/precompact.js' },
  { event: 'SubagentStop', script: 'dist/hooks/subagent.js' },
] as const;

interface SettingsHookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}
interface ClaudeSettings {
  hooks?: Partial<Record<string, SettingsHookEntry[]>>;
}

function check(level: CheckLevel, name: string, detail: string, fix?: string): CheckResult {
  return { level, name, detail, fix };
}

function checkDbFile(): CheckResult {
  if (!existsSync(PATHS.DB_FILE)) {
    return check(
      'WARN',
      'database.exists',
      `${PATHS.DB_FILE} does not exist yet`,
      'Run any memorex command (e.g. `memorex stats`) or open Claude Code once to create it.'
    );
  }
  return check('OK', 'database.exists', PATHS.DB_FILE);
}

function checkPermissions(): CheckResult[] {
  const out: CheckResult[] = [];
  for (const path of [PATHS.DB_FILE, PATHS.SESSION_FILE]) {
    if (!existsSync(path)) continue;
    try {
      const s = statSync(path);
      const mode = s.mode & 0o777;
      if (mode !== 0o600 && mode !== 0o644) {
        out.push(
          check(
            'WARN',
            'permissions',
            `${path} has mode 0${mode.toString(8)} (expected 0600)`,
            `chmod 600 ${path}`
          )
        );
      } else {
        out.push(check('OK', 'permissions', `${path} 0${mode.toString(8)}`));
      }
    } catch (err) {
      out.push(check('FAIL', 'permissions', `cannot stat ${path}: ${(err as Error).message}`));
    }
  }
  return out;
}

function checkSchemaVersion(db: Database.Database): CheckResult {
  try {
    const v = db.pragma('user_version', { simple: true }) as number;
    if (v === EXPECTED_SCHEMA) {
      return check('OK', 'schema.version', `v${v}`);
    }
    if (v < EXPECTED_SCHEMA) {
      return check(
        'WARN',
        'schema.version',
        `on-disk v${v}, expected v${EXPECTED_SCHEMA}`,
        'Open Claude Code or run any memorex CLI command — migrations run automatically.'
      );
    }
    return check(
      'FAIL',
      'schema.version',
      `on-disk v${v} is NEWER than this binary expects (v${EXPECTED_SCHEMA})`,
      'Upgrade memorex; you are running an older binary against a newer database.'
    );
  } catch (err) {
    return check('FAIL', 'schema.version', `cannot read pragma: ${(err as Error).message}`);
  }
}

function checkIntegrity(db: Database.Database): CheckResult {
  try {
    const r = db.pragma('integrity_check', { simple: true }) as string;
    if (r === 'ok') return check('OK', 'integrity', 'pragma integrity_check: ok');
    return check(
      'FAIL',
      'integrity',
      `pragma integrity_check: ${r.slice(0, 200)}`,
      `Back up first (\`memorex backup\`), then drop the DB at ${PATHS.DB_FILE} and let memorex rebuild it.`
    );
  } catch (err) {
    return check('FAIL', 'integrity', `cannot run integrity_check: ${(err as Error).message}`);
  }
}

function checkFtsSync(db: Database.Database): CheckResult {
  try {
    const m = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    const f = (db.prepare('SELECT COUNT(*) AS n FROM memories_fts').get() as { n: number }).n;
    if (m === f) return check('OK', 'fts.sync', `${m} rows in both memories and memories_fts`);
    return check(
      'WARN',
      'fts.sync',
      `memories=${m}, memories_fts=${f} — index drift`,
      "Run `sqlite3 ~/.memorex/memories.db \"INSERT INTO memories_fts(memories_fts) VALUES('rebuild');\"`."
    );
  } catch (err) {
    return check('FAIL', 'fts.sync', `cannot count: ${(err as Error).message}`);
  }
}

function readClaudeSettings(): { path: string; settings: ClaudeSettings | null } {
  const path = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(path)) return { path, settings: null };
  try {
    const raw = readFileSync(path, 'utf8');
    return { path, settings: JSON.parse(raw) as ClaudeSettings };
  } catch {
    return { path, settings: null };
  }
}

function checkHooks(): CheckResult[] {
  const out: CheckResult[] = [];
  const { path, settings } = readClaudeSettings();
  if (!settings) {
    out.push(
      check(
        'WARN',
        'hooks.settings',
        `${path} missing or unreadable`,
        'Run `./install.sh` from the memorex repo to wire the hooks.'
      )
    );
    return out;
  }
  out.push(check('OK', 'hooks.settings', path));

  const hooks = settings.hooks ?? {};
  for (const r of REQUIRED_HOOKS) {
    const entries: SettingsHookEntry[] = hooks[r.event] ?? [];
    const wired = entries.some((g) =>
      (g.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes('memorex'))
    );
    if (!wired) {
      out.push(
        check(
          'WARN',
          `hooks.${r.event}`,
          'not wired in settings.json',
          'Re-run `./install.sh` from the memorex repo.'
        )
      );
      continue;
    }
    // Resolve the actual command path so we can verify the script exists.
    const command = entries
      .flatMap((g) => g.hooks ?? [])
      .map((h) => (typeof h.command === 'string' ? h.command : ''))
      .find((c) => c.includes('memorex'));
    const m = command?.match(/node\s+(\S+\.js)/);
    if (!m) {
      out.push(
        check(
          'WARN',
          `hooks.${r.event}`,
          'wired but command not parseable',
          'Manual fix: ensure `command` is `node /path/to/dist/hooks/<name>.js`.'
        )
      );
      continue;
    }
    const scriptPath = m[1];
    if (!existsSync(scriptPath)) {
      out.push(
        check(
          'FAIL',
          `hooks.${r.event}`,
          `script missing: ${scriptPath}`,
          'Run `npm run build` in the memorex repo so dist/ exists.'
        )
      );
      continue;
    }
    out.push(check('OK', `hooks.${r.event}`, scriptPath));
  }
  return out;
}

function checkCapacity(db: Database.Database): CheckResult {
  try {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    const pct = (n / LIMITS.MAX_MEMORIES) * 100;
    if (n >= LIMITS.MAX_MEMORIES) {
      return check(
        'WARN',
        'capacity',
        `${n}/${LIMITS.MAX_MEMORIES} memories — at hard cap, eviction active`,
        'Run `memorex prune --yes` or pin/delete cold memories to make room.'
      );
    }
    if (pct >= 90) {
      return check(
        'WARN',
        'capacity',
        `${n}/${LIMITS.MAX_MEMORIES} memories (${pct.toFixed(0)}% — eviction will fire soon)`,
        'Pre-prune with `memorex prune --yes` to avoid surprise evictions.'
      );
    }
    return check('OK', 'capacity', `${n}/${LIMITS.MAX_MEMORIES}`);
  } catch (err) {
    return check('FAIL', 'capacity', `cannot count memories: ${(err as Error).message}`);
  }
}

function checkRecentActivity(db: Database.Database): CheckResult {
  try {
    const memCount = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    if (memCount === 0) return check('OK', 'activity', 'no memories yet (fresh install)');
    const cutoff = Math.floor(Date.now() / 1000) - 7 * TIME.DAY;
    const recent = (
      db.prepare('SELECT COUNT(*) AS n FROM inject_events WHERE ts >= ?').get(cutoff) as {
        n: number;
      }
    ).n;
    if (recent === 0) {
      return check(
        'WARN',
        'activity',
        'no inject events in the last 7 days despite stored memories',
        'Verify the UserPromptSubmit hook is wired (`memorex doctor` re-run after `./install.sh`).'
      );
    }
    return check('OK', 'activity', `${recent} inject events in last 7d`);
  } catch (err) {
    return check('OK', 'activity', `inject_events table not yet present (${(err as Error).message})`);
  }
}

export function runDoctor(db: Database.Database | null): DoctorReport {
  const results: CheckResult[] = [];
  results.push(checkDbFile());
  results.push(...checkPermissions());

  if (db) {
    results.push(checkSchemaVersion(db));
    results.push(checkIntegrity(db));
    results.push(checkFtsSync(db));
    results.push(checkCapacity(db));
    results.push(checkRecentActivity(db));
  } else {
    results.push(
      check(
        'WARN',
        'database.open',
        'database not opened (file missing — checks for schema/fts/capacity skipped)'
      )
    );
  }

  results.push(...checkHooks());

  const summary = results.reduce(
    (acc, r) => {
      if (r.level === 'OK') acc.ok++;
      else if (r.level === 'WARN') acc.warn++;
      else acc.fail++;
      return acc;
    },
    { ok: 0, warn: 0, fail: 0 }
  );

  return { results, summary };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('Memorex doctor');
  lines.push('');
  for (const r of report.results) {
    const tag = r.level === 'OK' ? '[OK  ]' : r.level === 'WARN' ? '[WARN]' : '[FAIL]';
    lines.push(`${tag} ${r.name}: ${r.detail}`);
    if (r.fix) lines.push(`        ↳ ${r.fix}`);
  }
  lines.push('');
  lines.push(`Summary: ${report.summary.ok} OK, ${report.summary.warn} WARN, ${report.summary.fail} FAIL`);
  return lines.join('\n');
}

/** Exit code derived from the worst check level seen. */
export function doctorExitCode(report: DoctorReport): number {
  if (report.summary.fail > 0) return 2;
  if (report.summary.warn > 0) return 1;
  return 0;
}
