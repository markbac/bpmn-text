import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (the "source" export
// condition), so tests never depend on a prior build.
const conditions = ['source', 'node', 'import', 'module', 'default'];

const workspaces = [
  'packages/core',
  'packages/layout',
  'packages/bpmn',
  'packages/render',
  'packages/cli',
  'packages/language-server',
  'apps/editor',
  'apps/vscode',
  'test',
];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      reporter: ['text-summary', 'json-summary'],
    },
    projects: workspaces.map((dir) => ({
      extends: true,
      root: dir,
      test: { name: dir },
    })),
  },
});
