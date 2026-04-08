import { describe, it, expect } from 'vitest';
import {
  scoreMemory,
  estimateTokens,
  formatMemoryForContext,
  type Memory,
} from '../types/scoring.js';

const baseMemory: Memory = {
  id: 1,
  type: 'user',
  title: 'Test Memory',
  body: 'This is a test memory body',
  project: null,
  tags: '[]',
  importance: 0.5,
  access_count: 0,
  created_at: Math.floor(Date.now() / 1000),
  accessed_at: Math.floor(Date.now() / 1000),
  expires_at: null,
};

describe('scoreMemory', () => {
  it('returns higher score for more important memories', () => {
    const low = scoreMemory({ ...baseMemory, importance: 0.1 });
    const high = scoreMemory({ ...baseMemory, importance: 0.9 });
    expect(high).toBeGreaterThan(low);
  });

  it('decays score for older memories', () => {
    const now = Math.floor(Date.now() / 1000);
    const recent = scoreMemory({ ...baseMemory, accessed_at: now });
    const old = scoreMemory({ ...baseMemory, accessed_at: now - 180 * 86400 });
    expect(recent).toBeGreaterThan(old);
  });

  it('boosts score for popular memories', () => {
    const unpopular = scoreMemory({ ...baseMemory, access_count: 0 });
    const popular = scoreMemory({ ...baseMemory, access_count: 100 });
    expect(popular).toBeGreaterThan(unpopular);
  });

  it('weighs types differently (project decays faster)', () => {
    const now = Math.floor(Date.now() / 1000);
    const project = scoreMemory({ ...baseMemory, type: 'project', accessed_at: now - 30 * 86400 });
    const user = scoreMemory({ ...baseMemory, type: 'user', accessed_at: now - 30 * 86400 });
    expect(user).toBeGreaterThan(project);
  });

  it('incorporates FTS rank when provided', () => {
    const withoutFts = scoreMemory(baseMemory);
    const withFts = scoreMemory(baseMemory, 0.5);
    expect(withFts).not.toBe(withoutFts);
  });
});

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('a'.repeat(40))).toBe(10);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });

  it('rounds up', () => {
    expect(estimateTokens('abc')).toBe(1);
  });
});

describe('formatMemoryForContext', () => {
  it('formats memory correctly', () => {
    const formatted = formatMemoryForContext(baseMemory);
    expect(formatted).toContain('[USER]');
    expect(formatted).toContain('Test Memory');
    expect(formatted).toContain('This is a test memory body');
  });

  it('truncates long bodies', () => {
    const longBody = 'a'.repeat(1000);
    const formatted = formatMemoryForContext({ ...baseMemory, body: longBody }, 100);
    expect(formatted).toContain('...');
    expect(formatted.length).toBeLessThan(longBody.length + 50);
  });
});
