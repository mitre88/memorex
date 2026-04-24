import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { PATHS } from './config.js';

/**
 * Project root resolution with two caches:
 *
 *   1. In-process cache (cachedRoot/cachedCwd) — trivial; frees repeat calls.
 *   2. On-disk cache at ~/.memorex/project-cache.json — shared across the
 *      short-lived hook processes Claude Code spawns. Without it, every
 *      UserPromptSubmit / SubagentStop / PreCompact would shell out to
 *      `git rev-parse --show-toplevel` and pay 20–50ms of subprocess setup
 *      per prompt. With it, the first hook invocation populates the cache
 *      and subsequent ones do a cheap JSON read.
 *
 * The on-disk cache is invalidated after PROJECT_CACHE_TTL_SECONDS so that
 * moving a repo (rare) or switching worktrees eventually propagates without
 * manual clearing. Errors in the cache layer always fall back to live git.
 */

const PROJECT_CACHE_FILE = join(PATHS.DB_DIR, 'project-cache.json');
const PROJECT_CACHE_TTL_SECONDS = 3600; // 1 hour

let cachedRoot: string | null = null;
let cachedCwd: string | null = null;

interface DiskCache {
  [cwd: string]: { root: string; at: number };
}

function isSafeGitPath(p: string): boolean {
  if (!p || p.includes('\0') || p.includes('\n')) return false;
  if (p.length > 4096) return false;
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

function readDiskCache(): DiskCache {
  try {
    if (!existsSync(PROJECT_CACHE_FILE)) return {};
    const raw = readFileSync(PROJECT_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as DiskCache;
    }
  } catch {
    // Corrupt cache → treat as empty. Will be rewritten by next git call.
  }
  return {};
}

function writeDiskCache(cache: DiskCache): void {
  try {
    if (!existsSync(PATHS.DB_DIR)) {
      mkdirSync(PATHS.DB_DIR, { recursive: true, mode: 0o700 });
    }
    writeFileSync(PROJECT_CACHE_FILE, JSON.stringify(cache), { mode: 0o600 });
  } catch {
    // Persistent cache is a best-effort optimization; failure is silent.
  }
}

function runGitToplevel(cwd: string): string | null {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 500,
    }).trim();
    return isSafeGitPath(out) ? resolve(out) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the canonical project key for the current process.
 *
 * Prefers the git repo root so that memories saved from any subdirectory
 * bind to the same project. Falls back to `process.cwd()` when not inside
 * a git repo (or git is unavailable).
 *
 * Result is cached in-process AND on disk so subsequent hook invocations
 * skip the git subprocess entirely.
 */
export function getProjectRoot(cwd: string = process.cwd()): string {
  if (cachedRoot && cachedCwd === cwd) return cachedRoot;

  const now = Math.floor(Date.now() / 1000);
  const cache = readDiskCache();
  const hit = cache[cwd];
  if (hit && now - hit.at < PROJECT_CACHE_TTL_SECONDS && isSafeGitPath(hit.root)) {
    cachedCwd = cwd;
    cachedRoot = hit.root;
    return hit.root;
  }

  const fromGit = runGitToplevel(cwd);
  const root = fromGit ?? cwd;

  // Persist even cwd-fallback results — avoids retrying git on non-repo dirs.
  cache[cwd] = { root, at: now };
  writeDiskCache(cache);

  cachedCwd = cwd;
  cachedRoot = root;
  return root;
}

/** Test helper — reset both caches so tests can swap cwd cleanly. */
export function resetProjectCache(): void {
  cachedRoot = null;
  cachedCwd = null;
  try {
    if (existsSync(PROJECT_CACHE_FILE)) {
      writeFileSync(PROJECT_CACHE_FILE, '{}', { mode: 0o600 });
    }
  } catch {
    /* noop */
  }
}
