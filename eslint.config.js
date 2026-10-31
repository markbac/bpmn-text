// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// Allowed workspace dependencies, matching docs/architecture.md §2.
// Keys are workspace directories; values are the workspaces each may import.
// Tests (files under a workspace's test/ directory) may also import
// packages/test-utils.
const workspaces = {
  'packages/core': [],
  'packages/layout': ['packages/core'],
  'packages/bpmn': ['packages/core', 'packages/layout'],
  'packages/render': ['packages/bpmn'],
  'packages/cli': [
    'packages/core',
    'packages/layout',
    'packages/bpmn',
    'packages/render',
  ],
  'packages/language-server': ['packages/core'],
  'apps/editor': ['packages/core', 'packages/layout', 'packages/bpmn'],
  'apps/vscode': ['packages/language-server'],
  'packages/test-utils': [],
};

const packageNames = {
  'packages/core': '@bpmn-text/core',
  'packages/layout': '@bpmn-text/layout',
  'packages/bpmn': '@bpmn-text/bpmn',
  'packages/render': '@bpmn-text/render',
  'packages/cli': 'bpmn-text',
  'packages/language-server': '@bpmn-text/language-server',
  'apps/editor': '@bpmn-text/editor',
  'apps/vscode': 'bpmn-text-vscode',
  'packages/test-utils': '@bpmn-text/test-utils',
};

const restrict = (files, forbidden, dir) => ({
  files,
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: forbidden.flatMap((name) => [name, `${name}/*`]),
            message: `${packageNames[dir]} may not depend on this package (see docs/architecture.md §2).`,
          },
        ],
      },
    ],
  },
});

const dependencyDirection = Object.entries(workspaces).flatMap(
  ([dir, allowed]) => {
    const forbidden = Object.keys(workspaces)
      .filter((other) => other !== dir && !allowed.includes(other))
      .map((other) => packageNames[other]);
    const inTests = forbidden.filter(
      (name) => name !== packageNames['packages/test-utils'],
    );
    return [
      restrict([`${dir}/**/*.ts`], forbidden, dir),
      restrict([`${dir}/test/**/*.ts`], inTests, dir),
    ];
  },
);

export default tseslint.config(
  { ignores: ['**/dist/', '**/build/', 'coverage/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['scripts/**/*.js'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  ...dependencyDirection,
  prettier,
);
