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

describe('shared definitions (#89)', () => {
  const shared = `start
sub Take payment
  start
  end error Payment failed
  on error Payment failed -> end Refused
end Paid
`;

  it('shares one error between the thrower and its boundary event', async () => {
    const xml = await valid(shared);
    expect(xml.match(/<bpmn:error /g)).toHaveLength(1);
    expect(xml).toContain(
      '<bpmn:error id="Error_payment_failed" name="Payment failed" />',
    );
    expect(xml.match(/errorRef="Error_payment_failed"/g)).toHaveLength(2);
  });

  it('keeps IDs stable when nothing changes', async () => {
    expect(await valid(shared)).toBe(await valid(shared));
  });

  it('shares definitions across pools and through explicit names', async () => {
    const xml = await valid(`pool A
  start
  throw signal Go now
  send Ask [message: Order] ~> Got it
  end
pool B
  start signal go  now
  end
  start message Got it [message: order]
  end
`);
    expect(xml.match(/<bpmn:signal /g)).toHaveLength(1);
    expect(xml.match(/<bpmn:message /g)).toHaveLength(1);
    expect(xml).toContain('<bpmn:message id="Message_order" name="Order" />');
    expect(xml).toMatch(/<bpmn:sendTask[^>]*messageRef="Message_order"/);
    expect(xml).toMatch(/<bpmn:messageFlow[^>]*messageRef="Message_order"/);
  });

  it('gives a send and a receive of one name a message', async () => {
    const xml = await valid(`pool A
  start
  send Order ~> @r
  end
pool B
  start
  receive Order @r
  end
`);
    expect(xml).toContain('<bpmn:message id="Message_order" name="Order" />');
    expect(xml).toMatch(/<bpmn:messageFlow[^>]*messageRef="Message_order"/);
    expect(xml).toMatch(/<bpmn:receiveTask[^>]*messageRef="Message_order"/);
  });

  it('gives a message flow no message when its ends disagree', async () => {
    const xml = await valid(`pool A
  start
  throw message One ~> @two
  end
pool B
  start message Two @two
  end
`);
    expect(xml).toMatch(/<bpmn:message id="Message_one"/);
    expect(xml).not.toMatch(/<bpmn:messageFlow[^>]*messageRef/);
  });
});

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
    expect(xml).toContain('<bpmn:target>Event_to_b_2_definition</bpmn:target>');
    expect(xml).toContain('<bpmn:source>Event_to_b_definition</bpmn:source>');
  });

  it('lays out the valid fixture', async () => {
    await valid(read('test/fixtures/valid/links.bpmnt'));
  });
});
