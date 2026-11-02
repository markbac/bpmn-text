import { describe, expect, it } from 'vitest';
import { check } from '../src/check.js';
import type { FlowNode } from '../src/model.js';

const codes = (source: string) => check(source).diagnostics.map((d) => d.code);
const node = (source: string, id: string): FlowNode =>
  check(source).model.pools[0]!.process!.nodes.find((n) => n.id === id)!;

describe('link events', () => {
  const repro = `start
task A
throw link To B
catch link To B
task B
end
`;

  it('draws no flow across the link', () => {
    const { model, diagnostics } = check(repro);
    expect(diagnostics).toEqual([]);
    expect(model.pools[0]!.process!.flows.map((f) => f.targetRef)).toEqual([
      'Activity_a',
      'Event_to_b',
      'Activity_b',
      'Event_end_1',
    ]);
  });

  it('pairs a throw and a catch by normalised name', () => {
    const source = `start
xor Which?
  a: throw link  TO  shipping
  b: throw link to shipping
catch link To shipping
end
`;
    const target = node(source, 'Event_to_shipping_3');
    expect(target.linkSources).toEqual([
      'Event_to_shipping',
      'Event_to_shipping_2',
    ]);
    expect(node(source, 'Event_to_shipping').linkTarget).toBe(target.id);
  });

  it('does not pair across a subprocess boundary', () => {
    const source = `start
sub Inner
  start
  throw link Out
start
catch link Out
end
`;
    expect(codes(source)).toEqual(expect.arrayContaining(['BT260', 'BT261']));
  });

  it('asks for a name', () => {
    const { diagnostics } = check('start\nthrow link\nend\n');
    expect(diagnostics[0]!.code).toBe('BT260');
    expect(diagnostics[0]!.message).toContain('needs a name');
  });

  it('reports a dead end after a catch, and an unreachable throw', () => {
    expect(
      codes(`start
throw link A
catch link A
start
end
throw link B
catch link B
`),
    ).toEqual(['BT302', 'BT301', 'BT302']);
  });
});
