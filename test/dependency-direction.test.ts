import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();

async function importErrors(file: string, specifier: string) {
  const [result] = await eslint.lintText(`import '${specifier}';\n`, {
    filePath: file,
  });
  return (result?.messages ?? []).filter(
    (m) => m.ruleId === 'no-restricted-imports',
  );
}

describe('workspace dependency direction', () => {
  it.each([
    ['packages/core/src/index.ts', '@bpmn-text/layout'],
    ['packages/layout/src/index.ts', '@bpmn-text/bpmn'],
    ['packages/bpmn/src/index.ts', 'bpmn-text'],
    ['packages/render/src/index.ts', '@bpmn-text/core'],
    ['packages/language-server/src/index.ts', '@bpmn-text/layout'],
    ['apps/editor/src/index.ts', '@bpmn-text/render'],
    ['apps/vscode/src/index.ts', '@bpmn-text/core/internal'],
    ['packages/core/src/index.ts', '@bpmn-text/test-utils'],
    ['packages/test-utils/src/index.ts', '@bpmn-text/core'],
  ])('%s may not import %s', async (file, specifier) => {
    expect(await importErrors(file, specifier)).toHaveLength(1);
  });

  it.each([
    ['packages/layout/src/index.ts', '@bpmn-text/core'],
    ['packages/bpmn/src/index.ts', '@bpmn-text/layout'],
    ['packages/render/src/index.ts', '@bpmn-text/bpmn'],
    ['packages/cli/src/index.ts', '@bpmn-text/render'],
    ['packages/language-server/src/index.ts', '@bpmn-text/core'],
    ['apps/editor/src/index.ts', '@bpmn-text/bpmn'],
    ['apps/vscode/src/index.ts', '@bpmn-text/language-server'],
    ['packages/core/test/parser.test.ts', '@bpmn-text/test-utils'],
    ['packages/cli/test/compile.test.ts', '@bpmn-text/render'],
  ])('%s may import %s', async (file, specifier) => {
    expect(await importErrors(file, specifier)).toHaveLength(0);
  });
});
