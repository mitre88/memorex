import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getProjectRoot, resetProjectCache } from '../utils/project.js';

describe('getProjectRoot', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memorex-project-'));
    resetProjectCache();
  });

  afterEach(() => {
    resetProjectCache();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('falls back to cwd when no git repo present', () => {
    const root = getProjectRoot(tempDir);
    expect(root).toBe(tempDir);
  });

  it('returns git top-level from a subdirectory', () => {
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    // git rev-parse is sensitive to realpath resolution on macOS (/tmp → /private/tmp).
    const realRoot = execSync('git rev-parse --show-toplevel', {
      cwd: tempDir,
      encoding: 'utf8',
    }).trim();
    const sub = join(tempDir, 'nested/deep');
    mkdirSync(sub, { recursive: true });

    resetProjectCache();
    const root = getProjectRoot(sub);
    expect(root).toBe(realRoot);
  });

  it('caches results per cwd', () => {
    const a = getProjectRoot(tempDir);
    const b = getProjectRoot(tempDir);
    expect(a).toBe(b);
  });
});
