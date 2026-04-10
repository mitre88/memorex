import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  rmdirSync,
  statSync,
} from 'fs';
import { dirname } from 'path';
import { CONFIG, SESSION } from './config.js';

interface SessionState {
  saves: number;
  started: number; // unix seconds
}

const SESSION_TTL = SESSION.TTL_SECONDS;
const LOCK_DIR_SUFFIX = '.lock';
const STALE_LOCK_SECONDS = 60;

/**
 * Simple atomic file locking using mkdir (atomic on most filesystems).
 * Detects and removes stale locks older than 60 seconds.
 */
function acquireLock(lockDir: string): boolean {
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

function readState(): SessionState {
  try {
    if (!existsSync(CONFIG.SESSION_FILE)) return fresh();
    const content = readFileSync(CONFIG.SESSION_FILE, 'utf8');
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
  const dir = dirname(CONFIG.SESSION_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG.SESSION_FILE, JSON.stringify(s), { mode: 0o600 });
  try {
    chmodSync(CONFIG.SESSION_FILE, 0o600);
  } catch {
    // Ignore permission errors
  }
}

export function canSave(): boolean {
  const lockDir = CONFIG.SESSION_FILE + LOCK_DIR_SUFFIX;
  if (!acquireLock(lockDir)) {
    // If can't acquire lock, assume another process is saving - be conservative
    return false;
  }
  try {
    return readState().saves < CONFIG.MAX_SAVES_PER_SESSION;
  } finally {
    releaseLock(lockDir);
  }
}

export function recordSave(): void {
  const lockDir = CONFIG.SESSION_FILE + LOCK_DIR_SUFFIX;
  if (!acquireLock(lockDir)) {
    // If can't acquire lock, skip recording (conservative approach)
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
  const lockDir = CONFIG.SESSION_FILE + LOCK_DIR_SUFFIX;
  if (!acquireLock(lockDir)) {
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
