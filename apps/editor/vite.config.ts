import { defineConfig } from 'vite';

// Workspace packages resolve to their TypeScript sources, as in the tests.
// `base: './'` makes the build work from any directory of a static host.
export default defineConfig({
  base: './',
  resolve: { conditions: ['source'] },
  worker: { format: 'es' },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
