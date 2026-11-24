import { defineConfig, type Options } from 'tsup';

// The extension is shipped as a bundle with no node_modules, so every
// dependency except `vscode` is bundled in. The workspace packages are
// read from their sources, so that a build needs no earlier build.
const shared: Options = {
  clean: false,
  noExternal: [/^(?!vscode$)/],
  esbuildOptions: (options) => {
    options.conditions = ['source', 'import', 'module', 'default'];
  },
};

export default defineConfig([
  {
    ...shared,
    clean: true,
    entry: { extension: 'src/extension.ts', server: 'src/server.ts' },
    format: ['cjs'],
    platform: 'node',
    external: ['vscode'],
    outExtension: () => ({ js: '.cjs' }),
  },
  {
    ...shared,
    entry: { webview: 'src/webview.ts' },
    format: ['iife'],
    platform: 'browser',
    outExtension: () => ({ js: '.js' }),
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.eot': 'dataurl',
      '.svg': 'dataurl',
    },
  },
]);
