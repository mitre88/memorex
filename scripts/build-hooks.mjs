#!/usr/bin/env node
/**
 * Bundle each hook entry into a single ESM file.
 *
 * Why bundle at all: Claude Code spawns a fresh Node process per hook event.
 * Cold start pays for every `import` resolved, every `.js` file the loader
 * has to read. Collapsing our internal modules (~8 source files) into a
 * single pre-linked file measurably cuts the module-resolution portion of
 * cold start.
 *
 * What we keep external:
 *   - `better-sqlite3` — native addon; can't be bundled. Still resolved from
 *     the workspace node_modules at runtime.
 *   - Node built-ins — always external by platform: 'node'.
 *
 * Output: dist/hooks/<name>.js (overwrites the tsc output, which is fine —
 * these files have the same ESM shape and the install.sh points here).
 */
import { build } from 'esbuild';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_DIR = join(ROOT, 'dist', 'hooks');

const HOOKS = ['start', 'end', 'prompt', 'precompact', 'subagent'];

mkdirSync(OUT_DIR, { recursive: true });

for (const name of HOOKS) {
  const outfile = join(OUT_DIR, `${name}.js`);
  // Fresh slate per hook so we don't ship stale tsc leftovers.
  rmSync(outfile, { force: true });
  await build({
    entryPoints: [join(ROOT, 'src', 'hooks', `${name}.ts`)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    // Keep only truly external things external. All `better-sqlite3` imports
    // survive as a plain `import Database from 'better-sqlite3'`, resolved
    // at hook runtime from the plugin's own node_modules.
    external: ['better-sqlite3'],
    // Banner: the shebang is preserved from source already, but some entries
    // had it; esbuild strips it. Re-add so users can still `./hooks/x.js`.
    banner: { js: '#!/usr/bin/env node' },
    // Don't bother minifying — these are small and we want stack traces.
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });
}

console.log(`bundled ${HOOKS.length} hooks → dist/hooks/`);
