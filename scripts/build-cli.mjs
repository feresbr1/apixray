// Bundle the CLI into one dependency-free file.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
await build({
  entryPoints: ['src/cli/index.ts'],
  outfile: 'dist/cli/apixray.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
});
