// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// Allowed workspace dependencies, matching docs/architecture.md §2.
// Keys are workspace directories; values are the workspaces each may import.
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
};

const dependencyDirection = Object.entries(workspaces).map(([dir, allowed]) => {
  const forbidden = Object.keys(workspaces)
    .filter((other) => other !== dir && !allowed.includes(other))
    .map((other) => packageNames[other]);
  return {
    files: [`${dir}/**/*.ts`],
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
  };
});

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
