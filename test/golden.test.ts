import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeBrowser,
  expectBpmnJsImport,
  expectModdleImport,
  expectSchemaValid,
} from '@bpmn-text/test-utils';
import { compile } from 'bpmn-text';
import { afterAll, describe, expect, it } from 'vitest';

afterAll(closeBrowser);

// The examples (#26, #31-#36). Each golden file sits next to its source; run
// `npx vitest run test/golden.test.ts -u` to accept an intended change.
const examples = [
  '01-simple',
  '02-gateways',
  '03-lanes',
  '04-collaboration',
  '05-events',
  '06-subprocess-data',
];
const root = join(import.meta.dirname, '..');

describe.each(examples)('golden: %s', (name) => {
  const result = compile(
    readFileSync(join(root, `examples/${name}.bpmnt`), 'utf8'),
  );

  it('compiles without errors or warnings', async () => {
    const { diagnostics } = await result;
    expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
  });

  it('matches the golden BPMN file', async () => {
    const { xml } = await result;
    await expect(xml).toMatchFileSnapshot(join(root, `examples/${name}.bpmn`));
  });

  it('validates and imports cleanly', async () => {
    const { xml } = await result;
    await expectSchemaValid(xml);
    await expectModdleImport(xml);
    await expectBpmnJsImport(xml);
  });
});
