import { execSync } from 'child_process';
import { resolve } from 'path';

let cachedRoot: string | null = null;
let cachedCwd: string | null = null;

// Reject obviously adversarial output from git (nulls, newlines, very long paths).
// We don't route through isValidProjectPath() here because that enforces "must be
// under $HOME", which breaks legitimate repos outside home (tmp, system paths,
// /private/var on macOS, etc.) — git's own output is our source of truth.
function isSafeGitPath(p: string): boolean {
  if (!p || p.includes('\0') || p.includes('\n')) return false;
  if (p.length > 4096) return false;
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * Resolve the canonical project key for the current process.
 *
 * Prefers the git repo root so that memories saved from any subdirectory
 * bind to the same project. Falls back to `process.cwd()` when not inside
 * a git repo (or git is unavailable).
 *
 * Result is cached per `process.cwd()` so repeated calls are free.
 */
export function getProjectRoot(cwd: string = process.cwd()): string {
  if (cachedRoot && cachedCwd === cwd) return cachedRoot;

  let root = cwd;
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 500,
    }).trim();
    if (isSafeGitPath(out)) {
      root = resolve(out);
    }
  } catch {
    // Not a git repo, or git missing — use cwd.
  }

  cachedCwd = cwd;
  cachedRoot = root;
  return root;
}

/** Test helper — reset the cache so tests can swap cwd cleanly. */
export function resetProjectCache(): void {
  cachedRoot = null;
  cachedCwd = null;
}
