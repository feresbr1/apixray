import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// Served from https://feresbr1.github.io/apixray/ (dev and preview use the same base path).
export default defineConfig({
  base: '/apixray/',
  plugins: [preact()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    target: 'es2022',
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
