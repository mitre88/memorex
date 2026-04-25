import { describe, it, expect, afterEach } from 'vitest';
import {
  cosineSim,
  vecToBuffer,
  bufferToVec,
  setMockEmbedder,
  getEmbedder,
  embedMemory,
  EMBEDDING_DIMS,
} from '../embeddings.js';

/**
 * Tests for the embedding primitives. We deliberately do NOT touch the
 * real `@xenova/transformers` import path — that requires a 22 MB model
 * download and an ONNX runtime, neither of which belongs in CI's hot loop.
 * Instead we install a deterministic mock via `setMockEmbedder()`.
 */

function fakeVec(seed: number, dims: number = EMBEDDING_DIMS): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    v[i] = Math.sin(seed * 0.137 + i * 0.011);
  }
  // L2-normalize so cosineSim degenerates cleanly.
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

describe('embeddings', () => {
  afterEach(() => setMockEmbedder(null));

  describe('cosineSim', () => {
    it('returns 1.0 (mapped) for identical vectors', () => {
      const v = fakeVec(7);
      // (1 + 1) / 2 = 1
      expect(cosineSim(v, v)).toBeCloseTo(1, 5);
    });

    it('returns 0.5 (mapped) for orthogonal vectors', () => {
      const a = new Float32Array(EMBEDDING_DIMS);
      const b = new Float32Array(EMBEDDING_DIMS);
      a[0] = 1;
      b[1] = 1;
      // (0 + 1) / 2 = 0.5
      expect(cosineSim(a, b)).toBeCloseTo(0.5, 5);
    });

    it('returns 0 for opposing direction (mapped from -1)', () => {
      const a = new Float32Array(EMBEDDING_DIMS);
      const b = new Float32Array(EMBEDDING_DIMS);
      a[0] = 1;
      b[0] = -1;
      // (-1 + 1) / 2 = 0
      expect(cosineSim(a, b)).toBeCloseTo(0, 5);
    });

    it('returns 0 when either vector is all zero', () => {
      const z = new Float32Array(EMBEDDING_DIMS);
      const v = fakeVec(3);
      expect(cosineSim(z, v)).toBe(0);
      expect(cosineSim(v, z)).toBe(0);
    });

    it('returns 0 when dimensions differ', () => {
      expect(cosineSim(new Float32Array(10), new Float32Array(20))).toBe(0);
    });
  });

  describe('serialization', () => {
    it('round-trips a vector through Buffer', () => {
      const v = fakeVec(42);
      const buf = vecToBuffer(v);
      expect(buf.length).toBe(EMBEDDING_DIMS * 4);
      const back = bufferToVec(buf);
      expect(back).not.toBeNull();
      expect(back!.length).toBe(EMBEDDING_DIMS);
      for (let i = 0; i < EMBEDDING_DIMS; i++) {
        expect(back![i]).toBeCloseTo(v[i], 5);
      }
    });

    it('returns null on empty / null / wrong-size input', () => {
      expect(bufferToVec(null)).toBeNull();
      expect(bufferToVec(undefined)).toBeNull();
      expect(bufferToVec(Buffer.alloc(0))).toBeNull();
      expect(bufferToVec(Buffer.alloc(EMBEDDING_DIMS * 4 - 1))).toBeNull();
    });
  });

  describe('mock embedder plumbing', () => {
    it('setMockEmbedder is honored by getEmbedder', async () => {
      let calls = 0;
      setMockEmbedder((text: string) => {
        calls++;
        return Promise.resolve(fakeVec(text.length));
      });
      const e = await getEmbedder();
      expect(e).not.toBeNull();
      const out = await e!('hello');
      expect(out.length).toBe(EMBEDDING_DIMS);
      expect(calls).toBe(1);
    });

    it('embedMemory produces a vector with mock embedder', async () => {
      setMockEmbedder((text: string) => Promise.resolve(fakeVec(text.length)));
      const v = await embedMemory('Auth refactor', 'Switched from session cookies to JWT.');
      expect(v).not.toBeNull();
      expect(v!.length).toBe(EMBEDDING_DIMS);
    });

    it('embedMemory returns null when embedder unavailable', async () => {
      setMockEmbedder(null);
      // Don't enable env var — getEmbedder should resolve null.
      const v = await embedMemory('a', 'b');
      expect(v).toBeNull();
    });
  });
});
