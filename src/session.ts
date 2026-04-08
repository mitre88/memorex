import { readFileSync, writeFileSync, existsSync } from 'fs';
import { CONFIG } from './config.js';

interface SessionState {
  saves: number;
  started: number; // unix seconds
}

const SESSION_TTL = 4 * 3600; // 4 hours

function readState(): SessionState {
  try {
    if (!existsSync(CONFIG.SESSION_FILE)) return fresh();
    const s: SessionState = JSON.parse(readFileSync(CONFIG.SESSION_FILE, 'utf8'));
    const age = Math.floor(Date.now() / 1000) - s.started;
    return age > SESSION_TTL ? fresh() : s;
  } catch {
    return fresh();
  }
}

function fresh(): SessionState {
  return { saves: 0, started: Math.floor(Date.now() / 1000) };
}

function writeState(s: SessionState): void {
  writeFileSync(CONFIG.SESSION_FILE, JSON.stringify(s));
}

export function canSave(): boolean {
  return readState().saves < CONFIG.MAX_SAVES_PER_SESSION;
}

export function recordSave(): void {
  const s = readState();
  s.saves++;
  writeState(s);
}

export function resetSession(): void {
  writeState(fresh());
}

export function sessionStats(): { saves: number; remaining: number } {
  const s = readState();
  return { saves: s.saves, remaining: Math.max(0, CONFIG.MAX_SAVES_PER_SESSION - s.saves) };
}
