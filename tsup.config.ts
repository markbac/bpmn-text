import { defineConfig } from 'tsup';

// Shared by every workspace's `build` script. The declaration build runs
// outside the project references, so it must not be a composite project.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: { compilerOptions: { composite: false } },
  clean: true,
});
