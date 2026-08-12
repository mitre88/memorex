import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  rmdirSync,
  statSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { CONFIG, SESSION } from './config.js';

interface SessionState {
  saves: number;
  started: number; // unix seconds
}

const SESSION_TTL = SESSION.TTL_SECONDS;
const LOCK_DIR_SUFFIX = '.lock';
const STALE_LOCK_SECONDS = 60;

/**
 * Resolve the session file on every call. Import-time `os.homedir()` froze
 * CONFIG.SESSION_FILE to the real ~/.memorex path, so tests that set HOME
 * still raced on one shared counter and CI hit the 5-save cap.
 */
function sessionFilePath(): string {
  return join(process.env.HOME || homedir(), '.memorex', 'session.json');
}

/**
 * Simple atomic file locking using mkdir (atomic on most filesystems).
 * Detects and removes stale locks older than 60 seconds.
 */
function acquireLock(lockDir: string): boolean {
  // mkdir of the lock dir is not recursive — a missing ~/.memorex made
  // every canSave() fail closed (ENOENT), which tests and first-run
  // installs reported as "session save limit reached".
  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(lockDir, { recursive: false });
    return true;
  } catch {
    // Lock exists — check if stale
    try {
      const stat = statSync(lockDir);
      const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
      if (ageSeconds > STALE_LOCK_SECONDS) {
        rmdirSync(lockDir);
        mkdirSync(lockDir, { recursive: false });
        return true;
      }
    } catch {
      // stat or rmdir failed — another process may have resolved it
    }
    return false;
  }
}

function releaseLock(lockDir: string): void {
  try {
    rmdirSync(lockDir);
  } catch {
    // Ignore errors on unlock
  }
}

/** Synchronous sleep used between lock retries. Bounded by SESSION.LOCK_RETRY_* config. */
function sleepSync(ms: number): void {
  // Atomics.wait on a private SAB blocks the thread without a busy loop,
  // which matters when we're running inside tight MCP request paths.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, Math.max(1, ms));
}

/**
 * Acquire the session lock with bounded exponential backoff.
 * Returns true only when we actually hold the lock — caller MUST call releaseLock.
 *
 * Previous implementation gave up after a single mkdir failure, which in practice
 * caused `canSave()` to return false under any lock contention (e.g. two MCP calls
 * racing). That silently ate saves. Retrying for a few ms recovers cleanly because
 * the critical sections here are microseconds.
 */
function acquireLockWithRetry(lockDir: string): boolean {
  for (let attempt = 0; attempt < SESSION.LOCK_RETRY_ATTEMPTS; attempt++) {
    if (acquireLock(lockDir)) return true;
    if (attempt < SESSION.LOCK_RETRY_ATTEMPTS - 1) {
      const delay = SESSION.LOCK_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      sleepSync(delay);
    }
  }
  return false;
}

function readState(): SessionState {
  try {
    const file = sessionFilePath();
    if (!existsSync(file)) return fresh();
    const content = readFileSync(file, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object') return fresh();
    const s = parsed as SessionState;
    const age = Math.floor(Date.now() / 1000) - s.started;
    if (age > SESSION_TTL) {
      const f = fresh();
      writeState(f);
      return f;
    }
    return s;
  } catch {
    const f = fresh();
    writeState(f);
    return f;
  }
}

function fresh(): SessionState {
  return { saves: 0, started: Math.floor(Date.now() / 1000) };
}

function writeState(s: SessionState): void {
  // Ensure directory exists with secure permissions
  const file = sessionFilePath();
  const dir = dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Ignore permission errors
  }
}

export function canSave(): boolean {
  const lockDir = sessionFilePath() + LOCK_DIR_SUFFIX;
  if (!acquireLockWithRetry(lockDir)) {
    // All retries exhausted — treat as "cannot confirm slot" and deny the save.
    // This is conservative but now only triggers after sustained contention.
    return false;
  }
  try {
    return readState().saves < CONFIG.MAX_SAVES_PER_SESSION;
  } finally {
    releaseLock(lockDir);
  }
}

export function recordSave(): void {
  const lockDir = sessionFilePath() + LOCK_DIR_SUFFIX;
  if (!acquireLockWithRetry(lockDir)) {
    // After full retry budget — skip recording (conservative).
    return;
  }
  try {
    const s = readState();
    s.saves++;
    writeState(s);
  } finally {
    releaseLock(lockDir);
  }
}

export function resetSession(): void {
  const lockDir = sessionFilePath() + LOCK_DIR_SUFFIX;
  if (!acquireLockWithRetry(lockDir)) {
    return;
  }
  try {
    writeState(fresh());
  } finally {
    releaseLock(lockDir);
  }
}

export function sessionStats(): { saves: number; remaining: number } {
  const s = readState();
  return { saves: s.saves, remaining: Math.max(0, CONFIG.MAX_SAVES_PER_SESSION - s.saves) };
}
