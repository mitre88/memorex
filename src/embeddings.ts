/**
 * Local sentence embeddings for hybrid semantic search.
 *
 * Why hybrid: pure FTS5 + synonyms covers ~15 buckets of English programming
 * terms. Spanish queries, paraphrase ("auth thing" vs "JWT middleware"), and
 * cross-language repos all fall through. A 384-dim sentence embedding from
 * `all-MiniLM-L6-v2` running locally via `@xenova/transformers` solves the
 * recall problem with no API calls and zero per-query cost beyond ~5–15 ms
 * of CPU on Apple Silicon.
 *
 * Why opt-in: the model is ~22 MB on first download (cached in
 * `~/.cache/transformers/` after that). We don't want existing users to pay
 * that cost without consent. Enable with `MEMOREX_EMBEDDINGS=1`.
 *
 * Why optional dep: `@xenova/transformers` pulls a native ONNX runtime
 * (`onnxruntime-node`) that may not build cleanly on every machine. Listing
 * it as `optionalDependencies` means `npm install` succeeds either way; we
 * just gracefully fall back to FTS-only if the import fails.
 *
 * Storage: 384 floats × 4 bytes = 1.5 KB per memory. At the 200-memory cap
 * that's ~300 KB total — trivial relative to the FTS index size.
 *
 * The hybrid score combines normalized FTS rank with cosine similarity:
 *   final = (1 - α) × fts_norm + α × cosine
 * Default α=0.4 (60% FTS, 40% semantic) keeps exact-keyword matches as the
 * primary signal — embeddings should help, not hijack.
 */

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const VECTOR_DIMS = 384;

export const EMBEDDING_DIMS = VECTOR_DIMS;

/** Whether embeddings are enabled for this process. Cached at module load. */
export const EMBEDDINGS_ENABLED = process.env.MEMOREX_EMBEDDINGS === '1';

/** Pluggable text → Float32Array. The default uses transformers; tests override it. */
export type Embedder = (text: string) => Promise<Float32Array>;

let embedderPromise: Promise<Embedder | null> | null = null;
let mockEmbedder: Embedder | null = null;

/**
 * Test-only override. Tests inject a deterministic embedder so they don't
 * depend on the 22 MB model download or ONNX runtime builds.
 */
export function setMockEmbedder(fn: Embedder | null): void {
  mockEmbedder = fn;
  embedderPromise = null; // reset memo so next getEmbedder() picks up the mock
}

/**
 * Lazily instantiate the embedder. Returns `null` (not throws) when:
 *   - `MEMOREX_EMBEDDINGS` is not set
 *   - `@xenova/transformers` isn't installed (optional dep skipped)
 *   - the model fails to load (network, disk, ONNX runtime)
 *
 * Callers MUST handle the `null` case as "embeddings unavailable, fall back".
 */
export function getEmbedder(): Promise<Embedder | null> {
  if (mockEmbedder) return Promise.resolve(mockEmbedder);
  if (!EMBEDDINGS_ENABLED) return Promise.resolve(null);
  if (embedderPromise) return embedderPromise;

  embedderPromise = (async (): Promise<Embedder | null> => {
    try {
      // Dynamic import isolates the heavy native dep from the cold path of
      // every other CLI command. If transformers isn't installed, this throws
      // ERR_MODULE_NOT_FOUND and we return null cleanly.
      const mod = (await import('@xenova/transformers')) as unknown as {
        pipeline: (
          task: string,
          model: string
        ) => Promise<
          (text: string, opts?: { pooling?: string; normalize?: boolean }) => Promise<{
            data: Float32Array | number[];
          }>
        >;
        env?: { allowLocalModels?: boolean; useBrowserCache?: boolean };
      };
      // Use the official cache path; don't write into the project tree.
      if (mod.env) {
        mod.env.allowLocalModels = false;
        mod.env.useBrowserCache = false;
      }
      const extractor = await mod.pipeline('feature-extraction', MODEL_ID);
      return async (text: string): Promise<Float32Array> => {
        const out = await extractor(text, { pooling: 'mean', normalize: true });
        // Some pipeline versions return Float32Array, others number[].
        return out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
      };
    } catch (err) {
      // Optional dep missing or model load failed. Log once via stderr so
      // the user sees the message in CLI runs but stdout-consuming hooks
      // (like UserPromptSubmit) aren't polluted.
      process.stderr.write(
        `[memorex] embeddings disabled: ${(err as Error).message}. ` +
          'Install @xenova/transformers and set MEMOREX_EMBEDDINGS=1 to enable.\n'
      );
      return null;
    }
  })();
  return embedderPromise;
}

/**
 * Convenience: embed a memory by concatenating title + body. Title is
 * weighted via repetition (×3) so titular vocabulary dominates the vector,
 * matching how BM25 weights are tilted toward title hits.
 */
export async function embedMemory(title: string, body: string): Promise<Float32Array | null> {
  const emb = await getEmbedder();
  if (!emb) return null;
  const text = `${title}. ${title}. ${title}. ${body}`.slice(0, 2000);
  return emb(text);
}

// ---- Serialization (Float32Array <-> Buffer for SQLite BLOB) -------------

/**
 * Serialize a 384-float vector to a Buffer suitable for SQLite BLOB storage.
 * Uses the underlying ArrayBuffer directly — no base64 / no JSON cost.
 */
export function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function bufferToVec(buf: Buffer | Uint8Array | null | undefined): Float32Array | null {
  if (!buf || buf.length === 0) return null;
  if (buf.length !== VECTOR_DIMS * 4) {
    // Wrong size — corrupt blob or different model. Drop it.
    return null;
  }
  // Make a copy so we don't tie the Float32Array's lifetime to the buffer's
  // possibly transient Node-managed memory.
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, VECTOR_DIMS);
}

// ---- Cosine similarity ---------------------------------------------------

/**
 * Cosine similarity between two L2-normalized vectors. The pipeline above
 * passes `normalize: true` so this collapses to a plain dot product. We
 * still divide by norms defensively for vectors that arrive un-normalized
 * (e.g. from older databases or the test mock).
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  // Map [-1, 1] → [0, 1] so it composes cleanly with FTS rank in [0, 1].
  return (dot / (Math.sqrt(na) * Math.sqrt(nb)) + 1) / 2;
}
