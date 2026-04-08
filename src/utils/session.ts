import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, rmdirSync } from 'fs';
import { dirname } from 'path';
import { CONFIG } from './config.js';

interface SessionState {
  saves: number;
  started: number; // unix seconds
}

const SESSION_TTL = 4 * 3600; // 4 hours
const LOCK_DIR_SUFFIX = '.lock';

/**
 * Simple atomic file locking using mkdir (atomic on most filesystems).
 * Returns true if lock acquired, false otherwise.
 */
function acquireLock(lockDir: string): boolean {
  try {
    mkdirSync(lockDir, { recursive: false });
    return true;
  } catch {
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
    const s: SessionState = JSON.parse(readFileSync(CONFIG.SESSION_FILE, 'utf8'));
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
