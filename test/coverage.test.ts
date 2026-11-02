import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkLayout } from '@bpmn-text/layout';
import {
  closeBrowser,
  expectBpmnJsImport,
  expectModdleImport,
  expectSchemaValid,
} from '@bpmn-text/test-utils';
import { compile } from 'bpmn-text';
import { afterAll, describe, expect, it } from 'vitest';

afterAll(closeBrowser);

const root = join(import.meta.dirname, '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');

/** Compiles and passes every output check, returning the XML (#85). */
async function valid(source: string) {
  const { xml, model, layout, diagnostics } = await compile(source);
  expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
  expect(checkLayout(model, layout).problems).toEqual([]);
  await expectSchemaValid(xml);
  await expectModdleImport(xml);
  await expectBpmnJsImport(xml);
  return xml;
}

describe('link events (#86)', () => {
  it('compiles the reproduction with no flow across the link', async () => {
    const xml = await valid(`start
task A
throw link To B
catch link To B
task B
end
`);
    expect(xml).not.toContain('Flow_to_b__to_b_2');
    expect(xml).toContain('<bpmn:linkEventDefinition');
    expect(xml).toContain(
      '<bpmn:target>Event_to_b_2_definition</bpmn:target>',
    );
    expect(xml).toContain('<bpmn:source>Event_to_b_definition</bpmn:source>');
  });

  it('lays out the valid fixture', async () => {
    await valid(read('test/fixtures/valid/links.bpmnt'));
  });
});
