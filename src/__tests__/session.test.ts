import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { canSave, recordSave, resetSession, sessionStats } from '../utils/session.js';

// Mock CONFIG for testing
const originalEnv = process.env.HOME;

describe('session', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memorex-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalEnv;
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('starts fresh with 0 saves', () => {
    resetSession();
    const stats = sessionStats();
    expect(stats.saves).toBe(0);
    expect(stats.remaining).toBe(5);
  });

  it('allows saving within limit', () => {
    resetSession();
    expect(canSave()).toBe(true);
    recordSave();
    expect(canSave()).toBe(true);
  });

  it('blocks saving at limit', () => {
    resetSession();
    for (let i = 0; i < 5; i++) {
      recordSave();
    }
    expect(canSave()).toBe(false);
  });

  it('tracks remaining correctly', () => {
    resetSession();
    recordSave();
    const stats = sessionStats();
    expect(stats.saves).toBe(1);
    expect(stats.remaining).toBe(4);
  });
});
