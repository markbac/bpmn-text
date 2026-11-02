import { check, format } from '@bpmn-text/core';
import { layout } from '@bpmn-text/layout';
import { describe, expect, it } from 'vitest';
import { generate } from '../src/index.js';

async function xml(source: string): Promise<string> {
  const { model, diagnostics } = check(source);
  expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return generate(model, await layout(model));
}
/** The attributes of the shape for `id`. */
const shape = (text: string, id: string) =>
  new RegExp(`<bpmndi:BPMNShape id="${id}_di"[^>]*>`).exec(text)?.[0] ?? '';
const edge = (text: string, id: string) =>
  new RegExp(`<bpmndi:BPMNEdge id="${id}_di"[^>]*>`).exec(text)?.[0] ?? '';

describe('pool colours', () => {
  const source = `pool Shop [color: #1F4E79, stroke: #102030]
  lanes Sales, Warehouse [color: orange, stroke: red]
  lane Sales
  start
  lane Warehouse
  end

pool Bank [collapsed, color: #000000]
`;

  it('looks like the same colour on a lane', async () => {
    const text = await xml(source);
    // A quarter of #1F4E79 on white, as bpmn-js draws a lane of that colour.
    expect(shape(text, 'Participant_bank')).toContain('bioc:fill="#BFBFBF"');
    const plain = await xml(`pool Shop [color: #1F4E79]
  lanes Sales, Warehouse
  lane Sales
  start
  lane Warehouse
  end
`);
    expect(shape(plain, 'Participant_shop')).toContain('bioc:fill="#C7D3DE"');
    expect(shape(plain, 'Lane_sales')).toContain('bioc:fill="#C7D3DE"');
  });

  it('does not mix with a lane that has its own colour', async () => {
    const text = await xml(source);
    const pool = shape(text, 'Participant_shop');
    expect(pool).not.toContain('bioc:fill');
    expect(pool).toContain('bioc:stroke="#102030"');
    const sales = shape(text, 'Lane_sales');
    expect(sales).toContain('bioc:fill="#1F4E79"');
    expect(sales).toContain('bioc:stroke="#102030"');
    const warehouse = shape(text, 'Lane_warehouse');
    expect(warehouse).toContain('bioc:fill="#FFE0B2"');
    expect(warehouse).toContain('bioc:stroke="#831311"');
  });
});

describe('colours on data and notes', () => {
  const source = `store Orders [stroke: red]
data Invoice [color: green]
start
task Bill [writes: Invoice (paid), reads: Orders]
note "Twice" [stroke: blue]
end
`;

  it('reach every use of the data', async () => {
    const text = await xml(source);
    expect(text).toMatch(
      /bpmnElement="DataObjectReference_[^"]*" bioc:fill="#C8E6C9"/,
    );
    expect(text).toMatch(
      /bpmnElement="DataStoreReference_[^"]*" bioc:stroke="#831311"/,
    );
  });

  it('colour a note', async () => {
    expect(await xml(source)).toMatch(
      /bpmnElement="TextAnnotation_[^"]*" bioc:stroke="#0D4372"/,
    );
  });

  it('reports invalid values, and survive formatting', () => {
    expect(
      check('start\nnote "A" [color: nope]\nend\n').diagnostics.map(
        (d) => d.code,
      ),
    ).toContain('BT104');
    expect(
      check('data D [stroke: nope]\nstart\nend\n').diagnostics[0]?.code,
    ).toBe('BT104');
    const formatted = format(source);
    expect(formatted).toContain('note Twice [stroke: blue]');
    expect(formatted).toContain('store Orders [stroke: red]');
  });
});

describe('option colors', () => {
  const body = `pool Shop
  lanes Sales, Warehouse
  lane Sales
  start
  task A [color: #123456]
  lane Warehouse
  task B [stroke: red]
  xor Q?
    a: end Yes
    b:
      sub C [collapsed]
      end No

pool Bank
  start In
  end Out
`;

  it('is off by default', async () => {
    const text = await xml(body);
    expect(shape(text, 'Activity_b')).not.toContain('bioc:fill');
    expect(shape(text, 'Lane_sales')).not.toContain('bioc:fill');
  });

  it('colours by type, under what is written', async () => {
    const text = await xml(`option colors types\n${body}`);
    const fill = (id: string) =>
      /bioc:fill="(#\w+)"/.exec(shape(text, id))?.[1];
    expect(fill('Event_start_1')).toBe('#C8E6C9');
    expect(fill('Gateway_q')).toBe('#FFF9C4');
    expect(fill('Activity_c')).toBe('#F3E5F5');
    expect(fill('Event_no')).toBe('#FFCDD2');
    expect(fill('Activity_a')).toBe('#123456');
    // Written stroke, scheme fill.
    expect(shape(text, 'Activity_b')).toContain('bioc:fill="#BBDEFB"');
    expect(shape(text, 'Activity_b')).toContain('bioc:stroke="#831311"');
    expect(shape(text, 'Lane_sales')).not.toContain('bioc:fill');
  });

  it('leaves flows black, unless a stroke is written on their source', async () => {
    const text = await xml(`option colors types\n${body}`);
    expect(edge(text, 'Flow_start_1__a')).not.toContain('bioc:stroke');
    expect(edge(text, 'Flow_b__q')).toContain('bioc:stroke="#831311"');
  });

  it('gives lanes and lane-less pools a colour each', async () => {
    const text = await xml(`option colors lanes\n${body}`);
    const fill = (id: string) =>
      /bioc:fill="(#\w+)"/.exec(shape(text, id))?.[1];
    expect(new Set([fill('Lane_sales'), fill('Lane_warehouse')]).size).toBe(2);
    expect(fill('Participant_bank')).toBeDefined();
    expect(fill('Participant_shop')).toBeUndefined();
    expect(shape(text, 'Activity_b')).not.toContain('bioc:fill');
  });

  it('keeps a pool colour for its lanes', async () => {
    const text = await xml(`option colors lanes
pool Shop [color: #000000]
  lanes Sales, Warehouse [color: red]
  lane Sales
  start
  lane Warehouse
  end
`);
    expect(shape(text, 'Lane_sales')).toContain('bioc:fill="#000000"');
    expect(shape(text, 'Lane_warehouse')).toContain('bioc:fill="#FFCDD2"');
  });

  it('does both with all', async () => {
    const text = await xml(`option colors all\n${body}`);
    expect(shape(text, 'Activity_b')).toContain('bioc:fill');
    expect(shape(text, 'Lane_sales')).toContain('bioc:fill');
  });

  it('rejects an unknown scheme', () => {
    const { diagnostics } = check('option colors rainbow\nstart\nend\n');
    expect(diagnostics[0]?.code).toBe('BT001');
    expect(diagnostics[0]?.message).toContain(
      'option colors none|types|lanes|all',
    );
  });
});
