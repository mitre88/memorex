/**
 * Ambient stub so `tsc` typechecks when the optional `@xenova/transformers`
 * package is not installed (CI Node 20 skips the native ONNX optional dep).
 * Runtime still dynamic-imports the real package and falls back to FTS-only.
 */
declare module '@xenova/transformers' {
  export function pipeline(
    task: string,
    model: string
  ): Promise<
    (
      text: string,
      opts?: { pooling?: string; normalize?: boolean }
    ) => Promise<{ data: Float32Array | number[] }>
  >;
  export const env: {
    allowLocalModels?: boolean;
    useBrowserCache?: boolean;
  };
}
