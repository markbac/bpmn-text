import { readFileSync, readdirSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ElementStmt, GatewayStmt } from '../src/ast.js';
import { parse } from '../src/parser.js';
import { printAst } from './print-ast.js';

const at = (d: {
  code: string;
  range: { start: { line: number; col: number } };
}) => `${d.code} @ ${d.range.start.line}:${d.range.start.col}`;
const body = (source: string) => {
  const result = parse(source);
  expect(result.diagnostics.map(at)).toEqual([]);
  return printAst(result.ast.body) as Record<string, unknown>[];
};
const diagnostics = (source: string) => parse(source).diagnostics.map(at);

describe('parser: elements, flows and document structure (#8)', () => {
  it('reads directives and pools', () => {
    const { ast } = parse(
      'title "Order"\noption xor-join direct\npool A\n  start\npool Bank [collapsed]\n',
    );
    expect(printAst(ast.directives)).toEqual([
      { type: 'title', value: '"Order"', range: '1:1-1:14' },
      { type: 'option', key: 'xor-join', value: 'direct', range: '2:1-2:23' },
    ]);
    expect(
      ast.body.map((s) => [s.type, s.type === 'pool' && !!s.body]),
    ).toEqual([
      ['pool', true],
      ['pool', false],
    ]);
  });

  it('reads an element with event type, name, id and attributes', () => {
    expect(body('end message Order shipped @shipped [color: red]')[0]).toEqual({
      type: 'element-stmt',
      element: {
        type: 'element',
        kind: 'end',
        keyword: 'end',
        eventType: 'message',
        name: 'Order shipped',
        id: 'shipped',
        attrs: [{ key: 'color', values: ['red'], range: '1:37-1:47' }],
        range: '1:1-1:48',
      },
      range: '1:1-1:48',
    });
  });

  it('reads `wait` as a timer catch event', () => {
    expect(body('wait 3 days')[0]!.element).toMatchObject({
      kind: 'catch',
      keyword: 'wait',
      eventType: 'timer',
      name: '3 days',
    });
  });

  it('keeps an event type word that is not lower case as part of the name', () => {
    expect(body('start Message received')[0]!.element).toMatchObject({
      kind: 'start',
      name: 'Message received',
    });
  });

  it('keeps commas and colons inside names', () => {
    expect(
      body('task Pick, pack and ship\ntask Ratio 3:1\ntask Note: check').map(
        (s) => (s.element as { name: string }).name,
      ),
    ).toEqual(['Pick, pack and ship', 'Ratio 3:1', 'Note: check']);
  });

  it('declares elements inline after a keyword and refers to them otherwise', () => {
    const [stmt] = parse('task A -> task B -(ok)-> end C -> D').ast.body as [
      ElementStmt,
    ];
    expect(
      stmt.tail.map((s) => [
        s.op,
        s.label?.value,
        s.targets.map((t) => t.type),
      ]),
    ).toEqual([
      ['sequence', undefined, ['element']],
      ['sequence', 'ok', ['element']],
      ['sequence', undefined, ['ref']],
    ]);
  });

  it('reads multi-target jumps, quoted references and @id references', () => {
    expect(body('-> A, "end of month", @b')[0]).toEqual({
      type: 'goto',
      tail: [
        {
          op: 'sequence',
          targets: [
            { type: 'ref', name: 'A', range: '1:4-1:5' },
            { type: 'ref', name: '"end of month"', range: '1:7-1:21' },
            { type: 'ref', id: 'b', range: '1:23-1:25' },
          ],
          range: '1:1-1:25',
        },
      ],
      range: '1:1-1:25',
    });
  });

  it('reads message flows in element tails and as statements', () => {
    const [send, message] = body(
      'send Request ~(invoice)~> Bank\nBank ~> Payment received',
    );
    expect(send!.tail).toEqual([
      {
        op: 'message',
        label: 'invoice',
        targets: [{ type: 'ref', name: 'Bank', range: '1:27-1:31' }],
        range: '1:14-1:31',
      },
    ]);
    expect(message).toMatchObject({
      type: 'message',
      source: { name: 'Bank' },
      step: { op: 'message' },
    });
  });

  it('reads lane and lanes statements with attributes', () => {
    expect(
      body('pool P\n  lanes A [color: green], B\n  lane B [stroke: red]')[0]!
        .body,
    ).toEqual([
      {
        type: 'lanes',
        lanes: [
          {
            name: 'A',
            attrs: [{ key: 'color', values: ['green'], range: '2:12-2:24' }],
            range: '2:9-2:25',
          },
          { name: 'B', range: '2:27-2:28' },
        ],
        range: '2:3-2:28',
      },
      {
        type: 'lane',
        name: 'B',
        attrs: [{ key: 'stroke', values: ['red'], range: '3:11-3:22' }],
        range: '3:3-3:23',
      },
    ]);
  });

  it('reports BT101 with a suggestion and BT102 for a disallowed event type', () => {
    const { diagnostics: d } = parse('taks A\nstart terminate\n');
    expect(d.map(at)).toEqual(['BT101 @ 1:1', 'BT102 @ 2:7']);
    expect(d[0]!.message).toContain('Did you mean `task`?');
    expect(d[0]!.fixes?.[0]?.edits[0]?.newText).toBe('task');
  });

  it('reports three independent errors in one file and keeps parsing', () => {
    const { ast, diagnostics: d } = parse(
      'start\ntask A [loop\nfoo bar\ntask B\n-> \nend\n',
    );
    expect(d.map(at)).toEqual(['BT001 @ 2:8', 'BT101 @ 3:1', 'BT001 @ 5:1']);
    expect(
      ast.body.map((s) => (s as ElementStmt).element?.name?.value ?? s.type),
    ).toEqual(['element-stmt', 'B', 'element-stmt']);
  });

  it('requires names on activities', () => {
    expect(diagnostics('task\n')).toEqual(['BT001 @ 1:1']);
  });

  it('does not declare gateways or keywords inline', () => {
    expect(diagnostics('task A -> xor B\n')).toEqual(['BT001 @ 1:11']);
  });
});

describe('parser: gateways and branches (#9)', () => {
  it('reads every branch form', () => {
    const [gw] = parse(
      'xor Approved?\n  yes: task Ship -> end Shipped\n  "label with: colon":\n    task X\n  - task Y\n  else:\n',
    ).ast.body as [GatewayStmt];
    expect(
      gw.branches!.map((b) => [
        b.form,
        b.label?.value,
        b.inline?.target.type,
        b.body.length,
      ]),
    ).toEqual([
      ['labelled', 'yes', 'element', 0],
      ['labelled', 'label with: colon', undefined, 1],
      ['bullet', undefined, 'element', 0],
      ['else', undefined, undefined, 0],
    ]);
  });

  it('reads a gateway without branches as a plain node', () => {
    expect(body('xor Merge @m\ntask A')[0]).toEqual({
      type: 'gateway',
      element: {
        type: 'element',
        kind: 'xor',
        keyword: 'xor',
        name: 'Merge',
        id: 'm',
        range: '1:1-1:13',
      },
      range: '1:1-1:13',
    });
  });

  it('parses gateways nested three levels deep', () => {
    const source = [
      'xor A?',
      '  yes:',
      '    and',
      '      -',
      '        or B?',
      '          x: task X',
      '          else:',
      '      - task Y',
      '  no: end N',
      'task After',
    ].join('\n');
    const [outer, after] = parse(source).ast.body as [GatewayStmt, ElementStmt];
    const and = outer.branches![0]!.body[0] as GatewayStmt;
    const or = and.branches![0]!.body[0] as GatewayStmt;
    expect([outer.element.kind, and.element.kind, or.element.kind]).toEqual([
      'xor',
      'and',
      'or',
    ]);
    expect(or.branches!.map((b) => b.form)).toEqual(['labelled', 'else']);
    expect(and.branches!.length).toBe(2);
    expect(outer.branches![1]!.inline?.target).toMatchObject({ kind: 'end' });
    expect(after.element.name?.value).toBe('After');
    expect(parse(source).diagnostics).toEqual([]);
  });

  it('reports `else:` on parallel and event-based gateways and forks (BT221)', () => {
    expect(
      diagnostics(
        'and\n  - task A\n  else: task B\nevent\n  else:\nfork\n  else:\n',
      ),
    ).toEqual(['BT221 @ 3:3', 'BT221 @ 5:3', 'BT221 @ 7:3']);
  });

  it('reads fork blocks', () => {
    expect(body('fork\n  -\n    task A\n  - task B')[0]).toMatchObject({
      type: 'fork',
      branches: [{ form: 'bullet' }, { form: 'bullet' }],
    });
  });

  it('reports a line in a branch block that is not a branch', () => {
    expect(diagnostics('xor A?\n  task X\n  yes: end Y\n')).toEqual([
      'BT001 @ 2:3',
    ]);
  });
});

describe('parser: subprocesses, boundaries, notes, data and attributes (#10)', () => {
  it('reads `sub` bodies with `on` lines anywhere', () => {
    const [sub] = body('sub Pay\n  start\n  on error Failed -> end X\n  end\n');
    expect(sub).toMatchObject({
      type: 'sub',
      body: [{ type: 'element-stmt' }, { type: 'element-stmt' }],
      boundaries: [{ type: 'boundary' }],
    });
  });

  it('reads a collapsed sub without a body', () => {
    expect(body('sub Credit check [collapsed]')[0]).toMatchObject({
      type: 'sub',
      element: { name: 'Credit check' },
    });
  });

  it('reads boundary events with inline and block chains', () => {
    const [user] = body(
      'user Approve\n  on timer 48 hours -> task Escalate\n  on message Cancelled [non-interrupting]\n    task Log\n    -> Archive\n',
    );
    expect(user!.boundaries).toMatchObject([
      {
        element: { kind: 'on', eventType: 'timer', name: '48 hours' },
        tail: [{ op: 'sequence' }],
      },
      {
        element: { eventType: 'message', attrs: [{ key: 'non-interrupting' }] },
        body: [{ type: 'element-stmt' }, { type: 'goto' }],
      },
    ]);
  });

  it('requires an event type on boundary events, and boundaries under activities only', () => {
    expect(
      diagnostics('task A\n  on Timeout\nstart\n  on timer x\non timer y\n'),
    ).toEqual(['BT102 @ 2:6', 'BT001 @ 4:3', 'BT001 @ 5:1']);
  });

  it('reads note, data, store and doc statements', () => {
    expect(
      body(
        'note Uses the snapshot # a comment\ndata Form [collection]\nstore DB\ndoc raw -> text # kept\ndoc\n  one\n\n  two\ngroup G [fit]\n  task A\n',
      ),
    ).toEqual([
      { type: 'note', text: 'Uses the snapshot', range: '1:1-1:23' },
      {
        type: 'data',
        kind: 'data',
        name: 'Form',
        attrs: [{ key: 'collection', range: '2:12-2:22' }],
        range: '2:1-2:23',
      },
      { type: 'data', kind: 'store', name: 'DB', range: '3:1-3:9' },
      { type: 'doc', text: 'raw -> text # kept', range: '4:1-4:23' },
      { type: 'doc', text: 'one\n\ntwo', range: '5:1-8:6' },
      {
        type: 'group',
        name: 'G',
        attrs: [{ key: 'fit', range: '9:10-9:13' }],
        body: [
          {
            type: 'element-stmt',
            element: {
              type: 'element',
              kind: 'task',
              keyword: 'task',
              name: 'A',
              range: '10:3-10:9',
            },
            range: '10:3-10:9',
          },
        ],
        range: '9:1-10:9',
      },
    ]);
  });

  it('reads multi-value attributes and flags, and warns about unknown ones (BT103)', () => {
    const { ast, diagnostics: d } = parse(
      'user Approve [reads: Order, Invoice, loop, writes: Log, "Loop", urgnet: high]',
    );
    expect(printAst((ast.body[0] as ElementStmt).element.attrs)).toEqual([
      { key: 'reads', values: ['Order', 'Invoice'], range: '1:15-1:36' },
      { key: 'loop', range: '1:38-1:42' },
      { key: 'writes', values: ['Log', '"Loop"'], range: '1:44-1:63' },
      { key: 'urgnet', values: ['high'], range: '1:65-1:77' },
    ]);
    expect(d.map((x) => [at(x), x.severity])).toEqual([
      ['BT103 @ 1:65', 'warning'],
    ]);
  });
});

describe('parser on the corpus', () => {
  const root = new URL('../../../', import.meta.url);
  const files = (dir: string) =>
    readdirSync(new URL(dir, root))
      .filter((f) => f.endsWith('.bpmnt'))
      .map((f) => `${dir}${f}`);
  const read = (file: string) => readFileSync(new URL(file, root), 'utf8');

  it.each(files('examples/'))('%s', (file) => {
    const result = parse(read(file));
    expect(result.diagnostics.map(at)).toEqual([]);
    expect(printAst(result.ast)).toMatchSnapshot();
  });

  it.each(files('test/fixtures/valid/'))(
    '%s parses without diagnostics',
    (file) => {
      expect(parse(read(file)).diagnostics.map(at)).toEqual([]);
    },
  );

  // The diagnostics the parser is responsible for; the rest come later.
  const parserCodes = /^BT(00\d|10[123]|221)$/;
  it.each(files('test/fixtures/diagnostics/'))(
    '%s reports its parser diagnostics',
    (file) => {
      const source = read(file);
      const expected = [
        ...source.matchAll(/^# expect: (BT\d{3}) @ (\d+):(\d+)$/gm),
      ]
        .filter((m) => parserCodes.test(m[1]!))
        .map((m) => `${m[1]} @ ${m[2]}:${m[3]}`);
      expect(parse(source).diagnostics.map(at).sort()).toEqual(expected.sort());
    },
  );

  it('never throws, on random input or on mutated examples', () => {
    const examples = files('examples/').map(read);
    fc.assert(
      fc.property(
        fc.constantFrom(...examples),
        fc.nat(),
        fc.string({
          unit: fc.constantFrom(...' \n-~>()[]:,@#"xor task -> '.split('')),
          maxLength: 20,
        }),
        (example, at, insert) => {
          const i = at % (example.length + 1);
          const result = parse(example.slice(0, i) + insert + example.slice(i));
          expect(result.ast.type).toBe('document');
        },
      ),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (source) => {
        parse(source);
      }),
      { numRuns: 300 },
    );
  });
});
