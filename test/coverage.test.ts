import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkLayout } from '@bpmn-text/layout';
import {
  closeBrowser,
  expectBpmnJsImport,
  expectModdleImport,
  expectSchemaValid,
} from '@bpmn-text/test-utils';
import { compile, format } from 'bpmn-text';
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

describe('ad-hoc subprocesses (#90)', () => {
  const example = read('examples/11-adhoc-subprocesses.bpmnt');

  it('writes adHocSubProcess with its ordering', async () => {
    const xml = await valid(example);
    expect(xml).toContain(
      '<bpmn:adHocSubProcess id="Activity_prepare_proposal" name="Prepare proposal" ordering="Parallel">',
    );
    expect(xml).toContain(
      '<bpmn:adHocSubProcess id="Activity_collect_references" name="Collect references" ordering="Sequential">',
    );
    expect(xml).not.toContain('multiInstanceLoopCharacteristics');
  });

  it('reports nothing about its body', async () => {
    const { diagnostics } = await compile(example);
    expect(diagnostics).toEqual([]);
  });

  it('has no implicit flow, but keeps explicit ones', async () => {
    const { model } = await compile(example);
    const sub = model.pools[0]!.process!.nodes.find(
      (n) => n.id === 'Activity_prepare_proposal',
    )!;
    expect(sub.children!.flows.map((f) => f.id)).toEqual([
      'Flow_review_wording__publish_draft',
    ]);
  });

  it('lays out its activities in a grid', async () => {
    const { layout } = await compile(`start
sub Work [adhoc]
  task A
  task B
  task C
  task D
  task E
end
`);
    const at = (id: string) => layout.shapes.get(`Activity_${id}`)!;
    expect(at('a').y).toBe(at('b').y);
    expect(at('a').y).toBe(at('c').y);
    expect(at('d').y).toBeGreaterThan(at('a').y);
    expect(at('d').x).toBe(at('a').x);
    expect(at('e').x).toBe(at('b').x);
    expect(at('b').x).toBeGreaterThan(at('a').x);
  });

  it('keeps flow inside branches and boundary chains', async () => {
    const xml = await valid(`start
sub Work [adhoc]
  task Plain
  task Watched
    on timer Late -> task Chase -> task Again
  xor Choice?
    yes:
      task One
      task Two
    no: task Three
end
`);
    expect(xml).toContain('Flow_one__two');
    expect(xml).toContain('Flow_chase__again');
    expect(xml).toContain('Flow_choice__three');
  });

  it('rejects being both adhoc and event', async () => {
    const { diagnostics } = await compile(`start
sub Work [adhoc, event]
  task A
end
`);
    expect(diagnostics.map((d) => d.code)).toContain('BT280');
  });

  it('warns about the flag on anything else', async () => {
    const { diagnostics } = await compile('start\ntask A [adhoc]\nend\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['BT105']);
  });

  it('formats the flag unchanged', () => {
    const source = `sub A [adhoc, sequential, collapsed]
  task B
`;
    expect(format(source)).toBe(source);
  });
});

describe('event subprocesses (#87)', () => {
  const example = read('examples/10-event-subprocesses.bpmnt');

  it('writes triggeredByEvent and isInterrupting', async () => {
    const xml = await valid(example);
    expect(xml.match(/triggeredByEvent="true"/g)).toHaveLength(4);
    expect(xml.match(/isInterrupting="false"/g)).toHaveLength(2);
    expect(xml).toContain('Event_every_morning');
  });

  it('gives a collapsed one its own plane', async () => {
    const xml = await valid(example);
    expect(xml).toContain('bpmnElement="Activity_daily_report"');
    expect(xml).toContain('id="Activity_daily_report_diagram"');
  });

  it('keeps implicit flow out of it', async () => {
    const { model, diagnostics } = await compile(`start
task A
sub On ping [event]
  start message Ping
  end
task B
end
`);
    expect(diagnostics).toEqual([]);
    expect(model.pools[0]!.process!.flows.map((f) => f.id)).toContain(
      'Flow_a__b',
    );
  });

  it('draws it below the main flow, inside the parent', async () => {
    const { layout } = await compile(example);
    const box = (id: string) => layout.shapes.get(id)!;
    const parent = box('Activity_handle_order');
    const inner = box('Activity_item_missing');
    expect(inner.y).toBeGreaterThan(box('Activity_pick_items').y);
    expect(inner.x).toBeGreaterThanOrEqual(parent.x);
    expect(inner.y + inner.height).toBeLessThanOrEqual(
      parent.y + parent.height,
    );
    const pool = box('Participant_shop');
    const cancel = box('Activity_cancellation');
    expect(cancel.y).toBeGreaterThan(parent.y + parent.height);
    expect(cancel.y + cancel.height).toBeLessThanOrEqual(pool.y + pool.height);
  });

  it('routes a message flow to it', async () => {
    await valid(`pool Customer
  start
  send Cancel ~> Cancelled
  end
pool Shop
  start
  task Work
  end
  sub Stop [event]
    start message Cancelled
    end
`);
  });

  it('copes with a pool holding nothing else, and wide strips', async () => {
    await valid(`pool Shop
  sub Only one [event]
    start message Ping
    task A
    task B
    task C
    end
  sub Another one [event]
    start message Pong
    task D
    task E
    task F
    end
`);
  });

  it('draws notes and data on it', async () => {
    await valid(`start
task A -> end Done
sub Watch [event, reads: Register, writes: Log]
  start message Ping
  end
note Runs any time
`);
  });

  it('reports what an event subprocess cannot do', async () => {
    const codes = async (source: string) =>
      (await compile(source)).diagnostics.map((d) => d.code);
    expect(await codes('start error\nend\n')).toEqual(['BT102']);
    expect(
      await codes(`start
sub A [event]
  start message One
  start message Two
  end
end
`),
    ).toContain('BT270');
    expect(
      await codes(`start
sub A [event]
  start error Bad [non-interrupting]
  end
end
`),
    ).toEqual(['BT240']);
    expect(
      await codes(`start
sub A [event]
  start message One
  end
  on timer Late -> end Stopped
end
`),
    ).toEqual(['BT240']);
    expect(await codes('start [non-interrupting]\nend\n')).toEqual(['BT105']);
    expect(await codes('start\ntask A [event]\nend\n')).toEqual(['BT105']);
  });

  it('counts its start event as a catcher for BT306', async () => {
    const { diagnostics } = await compile(`sub Outer
  start
  sub Inner
    start
    end error Failed
  end
  sub Handler [event]
    start error Failed
    end
start
end
`);
    expect(diagnostics.map((d) => d.code)).not.toContain('BT306');
  });

  it('formats the flag unchanged', () => {
    const source = `sub A [event, collapsed]
  start message One [non-interrupting]
  end
`;
    expect(format(source)).toBe(source);
  });
});

describe('data object states (#88)', () => {
  const states = read('examples/09-data-states.bpmnt');

  it('writes one data object and one reference per state', async () => {
    const xml = await valid(states);
    expect(xml.match(/<bpmn:dataObject /g)).toHaveLength(1);
    expect(xml.match(/<bpmn:dataObjectReference /g)).toHaveLength(3);
    for (const state of ['draft', 'approved', 'sent']) {
      expect(xml).toContain(
        `<bpmn:dataState id="DataObjectReference_invoice_${state}_state" name="${state}" />`,
      );
    }
    expect(xml).toContain('isCollection="true"');
  });

  it('shows the state under the name in bpmn-js', async () => {
    const xml = await valid(states);
    expect(xml).toContain('name="Invoice&#10;[approved]"');
  });

  it('keeps literal brackets, and drops a bare declaration', async () => {
    const xml = await valid(read('test/fixtures/valid/data-states.bpmnt'));
    expect(xml).toContain('name="Report (copy)"');
    expect(xml.match(/<bpmn:dataObject /g)).toHaveLength(2);
    expect(xml).not.toContain('id="DataObjectReference_report"');
    expect(xml).toContain('id="DataObjectReference_report_checked"');
  });

  it('round-trips through the formatter', () => {
    const source = `data Invoice (approved) [collection]
task A [reads: "Invoice (copy)", writes: Invoice (draft)]
`;
    expect(format(source)).toBe(source);
  });
});

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
