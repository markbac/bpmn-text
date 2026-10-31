import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check } from '../src/check.js';
import type { Diagnostic } from '../src/diagnostics.js';
import type { FlowNode, Model } from '../src/model.js';
import { printAst } from './print-ast.js';
import { showFlows } from './show-model.js';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const files = (dir: string) =>
  readdirSync(new URL(dir, root))
    .filter((f) => f.endsWith('.bpmnt'))
    .map((f) => `${dir}${f}`);
const at = (d: Diagnostic) =>
  `${d.code} @ ${d.range.start.line}:${d.range.start.col}`;

/** Checks `source`, expecting no diagnostics other than those listed. */
function model(source: string, expected: string[] = []): Model {
  const result = check(source);
  expect(result.diagnostics.map(at)).toEqual(expected);
  return result.model;
}
const nodes = (m: Model): FlowNode[] =>
  m.pools.flatMap((p) => p.process?.nodes ?? []);
const flows = (m: Model) =>
  m.pools
    .flatMap((p) => p.process?.flows ?? [])
    .map(
      (f) => `${f.sourceRef} -> ${f.targetRef}${f.name ? ` [${f.name}]` : ''}`,
    );

describe('model builder: declare pass (#11)', () => {
  it('places every node of example 03 in the lane its comments give', () => {
    const lanes = Object.fromEntries(
      nodes(model(read('examples/03-lanes.bpmnt'))).map((n) => [
        n.name,
        n.laneId,
      ]),
    );
    expect(lanes).toEqual({
      'Leave needed': 'Lane_employee',
      'Submit leave request': 'Lane_employee',
      'Review request': 'Lane_manager',
      'Approved?': 'Lane_manager',
      'Update leave balance': 'Lane_hr',
      'Read rejection reason': 'Lane_employee',
      'Request rejected': 'Lane_employee',
      'Inform team': 'Lane_manager', // restored after the gateway block
      'Leave booked': 'Lane_employee',
    });
  });

  it('orders lanes by `lanes`, then by first appearance, and applies `[lane: X]`', () => {
    const m = model(
      'pool P\n  lanes B\n  lane A\n  start\n  task X [lane: C]\n  lane B\n  end\n',
    );
    expect(m.pools[0]!.lanes.map((l) => l.name)).toEqual(['B', 'A', 'C']);
    expect(nodes(m).map((n) => n.laneId)).toEqual([
      'Lane_a',
      'Lane_c',
      'Lane_b',
    ]);
  });

  it('creates an implicit pool, drawn as a participant only when it has lanes', () => {
    const plain = model('title "Plain"\nstart\nend\n');
    expect([
      plain.collaboration,
      plain.pools[0]!.implicit,
      plain.pools[0]!.name,
    ]).toEqual([false, true, 'Plain']);
    const laned = model('lane A\nstart\nend\n');
    expect([
      laned.collaboration,
      laned.pools[0]!.name,
      laned.pools[0]!.lanes.length,
    ]).toEqual([true, 'Process', 1]);
  });

  it('keeps groups transparent and collects their members across pools', () => {
    const m = model(read('test/fixtures/valid/groups.bpmnt'));
    expect(m.groups.map((g) => [g.name, g.fit, g.members.length])).toEqual([
      ['Ordering', false, 4],
      ['Delivery', false, 5],
      ['After-sales', true, 3],
    ]);
  });

  it('normalises colours on pools, lanes, groups and elements (#61)', () => {
    const m = model(read('test/fixtures/valid/colours.bpmnt'));
    const pool = m.pools[0]!;
    expect(pool.style).toEqual({ fill: '#F0F4FF', stroke: '#1F4E79' });
    expect(pool.lanes.map((l) => l.style)).toEqual([
      { fill: '#1F4E79' },
      { fill: '#C8E6C9' },
      { fill: '#FFEEAA' },
    ]);
    const style = (name: string) =>
      pool.process!.nodes.find((n) => n.name === name)!.style;
    expect(style('Order received')).toEqual({ stroke: '#0D4372' });
    expect(style('Check order')).toBeUndefined();
    expect(style('Done')).toEqual({ fill: '#E1BEE7', stroke: '#663399' });
    const groups = model(read('test/fixtures/valid/groups.bpmnt')).groups;
    expect(groups.map((g) => g.style)).toEqual([
      undefined,
      { fill: '#FFF5F5' },
      { stroke: '#AA3333' },
    ]);
  });

  it('attaches documentation, notes and data', () => {
    const doc = model(read('test/fixtures/valid/documentation.bpmnt'));
    expect(doc.documentation).toBe(
      'Handles refunds for orders returned within 30 days.',
    );
    expect(doc.pools[0]!.documentation).toBe(
      'The online shop, including its returns desk.',
    );
    expect(
      nodes(doc).find((n) => n.name === 'Validate order')!.documentation,
    ).toBe(
      'Checks each line against the catalogue -> unknown items are rejected (see #refund-rules).\nA second doc line is joined to the first with a line break.',
    );
    expect(
      nodes(doc).find((n) => n.name === 'Refund payment')!.documentation,
    ).toBe(
      'Refunds the original payment method.\n\nException: gift cards are refunded as store credit.',
    );
    const data = model(read('examples/06-subprocess-data.bpmnt'));
    const process = data.pools[0]!.process!;
    expect(process.dataObjects.map((d) => d.id)).toEqual([
      'DataObject_hours_report',
      'DataObject_invoice',
    ]);
    expect(data.dataStores.map((d) => d.id)).toEqual([
      'DataStore_accounting_db',
    ]);
    const collect = process.nodes.find(
      (n) => n.name === 'Collect billable hours',
    )!;
    expect(process.dataStoreReferences).toMatchObject([
      {
        id: 'DataStoreReference_accounting_db',
        store: 'DataStore_accounting_db',
      },
    ]);
    expect([collect.reads, collect.writes]).toEqual([
      [
        {
          id: 'DataInputAssociation_collect_billable_hours__accounting_db',
          dataRef: 'DataStoreReference_accounting_db',
        },
      ],
      [
        {
          id: 'DataOutputAssociation_collect_billable_hours__hours_report',
          dataRef: 'DataObjectReference_hours_report',
        },
      ],
    ]);
    expect(process.annotations).toMatchObject([
      {
        attachedTo: collect.id,
        text: 'Includes contractors from the timesheet export',
      },
    ]);
  });
});

describe('model builder: references (#12)', () => {
  it('resolves forward references, @ids and names regardless of case and spacing', () => {
    const m = model(
      'start\nxor A?\n  yes:\n    -> @later\n  no:\n    ->   CHECK   it\ntask Check it\nend\ntask Later @later\nend\n',
    );
    expect(flows(m)).toContain('Gateway_a -> later [yes]');
    expect(flows(m)).toContain('Gateway_a -> Activity_check_it [no]');
  });

  it('lists the candidates of an ambiguous reference (BT201)', () => {
    const { diagnostics } = check(
      read('test/fixtures/diagnostics/BT201-ambiguous-reference.bpmnt'),
    );
    expect(diagnostics[0]!.message).toBe(
      '`Review` is ambiguous: 2 elements have this name (lines 4, 5). Give the one you mean an @id and refer to it by that.',
    );
    expect(diagnostics[0]!.related?.map((r) => r.range.start.line)).toEqual([
      4, 5,
    ]);
  });

  it('suggests the closest name for an unknown reference, with a fix (BT202)', () => {
    const { diagnostics } = check(
      read('test/fixtures/diagnostics/BT202-unknown-reference.bpmnt'),
    );
    expect(diagnostics[0]!.message).toBe(
      'Nothing is called `Chek order`. Did you mean `Check order`?',
    );
    expect(diagnostics[0]!.fixes?.[0]?.edits).toEqual([
      { range: diagnostics[0]!.range, newText: 'Check order' },
    ]);
  });

  it('accepts pools as message-flow endpoints', () => {
    const m = model(read('examples/04-collaboration.bpmnt'), ['BT303 @ 11:1']);
    expect(
      m.messageFlows.map((f) => `${f.sourceRef} ~> ${f.targetRef}`),
    ).toContain('Participant_bank ~> Activity_payment_received');
  });
});

describe('model builder: implicit flow and joins (#58)', () => {
  it.each(files('examples/'))('%s matches its hand-verified flows', (file) => {
    const flowsFile = file
      .replace('examples/', 'test/fixtures/flows/')
      .replace('.bpmnt', '.flows');
    expect(showFlows(check(read(file)).model)).toBe(read(flowsFile));
  });

  it('inserts exactly one AND-join and one OR-join in example 02, and no XOR-join', () => {
    const joins = nodes(model(read('examples/02-gateways.bpmnt'))).filter(
      (n) => n.generated,
    );
    expect(joins.map((n) => n.kind).sort()).toEqual([
      'inclusiveGateway',
      'parallelGateway',
    ]);
  });

  it('keeps three start chains in one pool independent', () => {
    const m = model(
      'pool P\n  start A\n  task 1\n  end\n  start B\n  task 2\n  end\n  start C\n  task 3\n  end\n',
    );
    const starts = new Set(
      nodes(m)
        .filter((n) => n.kind === 'startEvent')
        .map((n) => n.id),
    );
    expect(starts.size).toBe(3);
    expect(
      m.pools[0]!.process!.flows.filter((f) => starts.has(f.targetRef)),
    ).toEqual([]);
    expect(flows(m)).toEqual([
      'Event_a -> Activity_1',
      'Activity_1 -> Event_end_1',
      'Event_b -> Activity_2',
      'Activity_2 -> Event_end_2',
      'Event_c -> Activity_3',
      'Activity_3 -> Event_end_3',
    ]);
  });

  it('reports what a new start event leaves open as a dead end (BT302)', () => {
    model('start\ntask A\nstart\nend\n', ['BT302 @ 2:1']);
  });

  it('joins nested splits from the inside out', () => {
    const m = model(
      'start\nxor A?\n  yes:\n    and\n      - task X\n      - task Y\n  no: task Z\ntask After\nend\n',
    );
    expect(flows(m)).toEqual(
      expect.arrayContaining([
        'Activity_x -> Gateway_join_after_join_after_after',
        'Activity_y -> Gateway_join_after_join_after_after',
        'Gateway_join_after_join_after_after -> Gateway_join_after_after',
        'Activity_z -> Gateway_join_after_after',
        'Gateway_join_after_after -> Activity_after',
      ]),
    );
    expect(
      nodes(m)
        .filter((n) => n.generated)
        .map((n) => n.kind),
    ).toEqual(['exclusiveGateway', 'parallelGateway']);
  });

  it('merges open XOR branches directly with `option xor-join direct`', () => {
    const m = model(
      'option xor-join direct\nstart\nxor A?\n  yes: task X\n  no: task Y\nend\n',
    );
    expect(nodes(m).some((n) => n.generated)).toBe(false);
    expect(flows(m)).toEqual(
      expect.arrayContaining([
        'Activity_x -> Event_end_1',
        'Activity_y -> Event_end_1',
      ]),
    );
  });

  it('puts an inserted join in the lane of the next statement', () => {
    const m = model(read('examples/04-collaboration.bpmnt'), ['BT303 @ 11:1']);
    expect(nodes(m).find((n) => n.generated)!.laneId).toBe('Lane_finance');
  });

  it('merges an open interrupting boundary chain into the host successor', () => {
    expect(
      flows(
        model(read('examples/05-events.bpmnt'), [
          'BT304 @ 7:42',
          'BT304 @ 12:1',
        ]),
      ),
    ).toEqual(
      expect.arrayContaining([
        'Activity_resolve_ticket -> Gateway_join_after_ask_customer_to_confirm',
        'Activity_specialist_investigation -> Gateway_join_after_ask_customer_to_confirm',
      ]),
    );
  });

  it('fans out without a gateway with `fork` and multi-target jumps', () => {
    const m = model(read('test/fixtures/valid/fork.bpmnt'));
    expect(flows(m)).toEqual(
      expect.arrayContaining([
        'Activity_publish_order -> Activity_update_billing',
        'Activity_publish_order -> Activity_update_crm',
        'Activity_archive_order -> Activity_audit_log',
        'Activity_archive_order -> Activity_search_index',
      ]),
    );
    expect(
      nodes(m)
        .filter((n) => n.kind.endsWith('Gateway'))
        .map((n) => n.name),
    ).toEqual(['Sync done']);
  });

  it('sets default flows from `else:` and labels from branches and `-(label)->`', () => {
    const m = model(
      'start -(go)-> task A\nxor B?\n  ok: end C\n  else: end D\n',
    );
    const gateway = nodes(m).find((n) => n.name === 'B?')!;
    expect(flows(m)).toEqual([
      'Event_start_1 -> Activity_a [go]',
      'Activity_a -> Gateway_b',
      'Gateway_b -> Event_c [ok]',
      'Gateway_b -> Event_d',
    ]);
    expect(gateway.default).toBe('Flow_b__d');
  });
});

describe('model builder: IDs (#15)', () => {
  const twoPools = (order: 'ab' | 'ba') => {
    const a = 'pool Alpha\n  start\n  task Check\n  end Done\n';
    const b = 'pool Beta\n  start\n  task Check\n  task Other\n  end Done\n';
    return check(order === 'ab' ? a + b : b + a).model;
  };
  const ids = (m: Model) =>
    new Map(
      m.pools.map((p) => [p.name, p.process!.nodes.map((n) => n.id).join(' ')]),
    );

  it('is deterministic and does not depend on pool order', () => {
    expect(ids(twoPools('ab'))).toEqual(ids(twoPools('ba')));
    expect(ids(twoPools('ab'))).toEqual(
      new Map([
        ['Alpha', 'Event_alpha_start_1 Activity_alpha_check Event_alpha_done'],
        [
          'Beta',
          'Event_beta_start_1 Activity_beta_check Activity_other Event_beta_done',
        ],
      ]),
    );
  });

  it('numbers clashes within a pool in document order and keeps @ids', () => {
    const m = model('start\ntask A\ntask A @mine\ntask a\nend\n');
    expect(nodes(m).map((n) => n.id)).toEqual([
      'Event_start_1',
      'Activity_a',
      'mine',
      'Activity_a_2',
      'Event_end_1',
    ]);
  });

  it('rejects an id that is not a valid XML name', () => {
    model('start\ntask A [id: 1st]\nend\n', ['BT001 @ 2:13']);
  });
});

describe('validator (#14)', () => {
  it('can turn rules off', () => {
    const source = 'start\nsend Notify\nend\n';
    expect(check(source).diagnostics.map((d) => d.code)).toEqual(['BT304']);
    expect(check(source, { rules: { BT304: false } }).diagnostics).toEqual([]);
  });

  it('treats a merge gateway with one way out as valid, not a single branch', () => {
    model(read('test/fixtures/valid/explicit-gateway.bpmnt'));
  });
});

describe('check() on the corpus', () => {
  it.each(files('test/fixtures/diagnostics/'))(
    '%s reports exactly its expected diagnostics',
    (file) => {
      const source = read(file);
      const expected = [
        ...source.matchAll(/^# expect: (BT\d{3}) @ (\d+):(\d+)$/gm),
      ].map((m) => `${m[1]} @ ${m[2]}:${m[3]}`);
      expect(check(source).diagnostics.map(at).sort()).toEqual(expected.sort());
    },
  );

  it.each(files('test/fixtures/valid/'))('%s has no diagnostics', (file) => {
    expect(check(read(file)).diagnostics.map(at)).toEqual([]);
  });

  it.each(files('examples/'))(
    '%s has no errors or warnings, and matches its IR snapshot',
    (file) => {
      const { model: m, diagnostics } = check(read(file));
      expect(diagnostics.filter((d) => d.severity !== 'info').map(at)).toEqual(
        [],
      );
      expect(printAst(m)).toMatchSnapshot();
    },
  );
});
