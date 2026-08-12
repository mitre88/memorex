import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // better-sqlite3 is a native addon; the default thread pool can hang
    // the worker on Node 24/26. Forks keep each file in its own process.
    pool: 'forks',
    exclude: ['node_modules/', 'dist/', '**/*.d.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.d.ts', '**/*.config.*'],
    },
  },
});
