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
  pinned: 0,
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

  it('ignores positive FTS ranks (fallback path)', () => {
    // Positive fts_rank is what the broken pre-0.3.0 code branched on. In SQLite
    // BM25 never returns positives for real matches, so treat as "no signal".
    const fallback = scoreMemory(baseMemory, 0);
    const positive = scoreMemory(baseMemory, 0.5);
    expect(positive).toBe(fallback);
  });

  it('uses FTS rank magnitude when negative (real BM25 match)', () => {
    // Regression: before v0.3.0 the BM25 sign check was inverted and FTS rank
    // was effectively ignored. Negative rank → relevance boost.
    const weak = scoreMemory(baseMemory, -1);
    const strong = scoreMemory(baseMemory, -8);
    expect(strong).toBeGreaterThan(weak);
  });

  it('caps FTS relevance at the configured norm', () => {
    // Extremely strong match should not explode the score unboundedly.
    const capped = scoreMemory(baseMemory, -1000);
    const strong = scoreMemory(baseMemory, -10);
    // With FTS_RANK_NORM=5 both saturate at relevance=1.
    expect(capped).toBeCloseTo(strong, 5);
  });
});

describe('estimateTokens', () => {
  it('estimates ~3 chars per token', () => {
    expect(estimateTokens('a'.repeat(30))).toBe(10);
    expect(estimateTokens('a'.repeat(99))).toBe(33);
  });

  it('rounds up', () => {
    expect(estimateTokens('abc')).toBe(1);
  });
});

describe('formatMemoryForContext', () => {
  it('formats memory correctly', () => {
    const formatted = formatMemoryForContext(baseMemory);
    expect(formatted).toContain('U:');
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
