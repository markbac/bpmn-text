import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic } from '@bpmn-text/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkDmn,
  formatDmn,
  parseDmn,
  suggestDmn,
  type DmnModel,
} from '../src/index.js';

const root = join(import.meta.dirname, '../../..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const files = (dir: string) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.dmnt'))
    .map((f) => `${dir}${f}`);

const examples = files('examples/dmn/');
const valid = files('test/fixtures/dmn/valid/');
const diagnosticsFixtures = files('test/fixtures/dmn/diagnostics/');
const corpus = [...examples, ...valid, ...diagnosticsFixtures];

const at = (d: Diagnostic) =>
  `${d.code} @ ${d.range.start.line}:${d.range.start.col}`;

/** The AST without ranges, for snapshots and comparisons. */
const shape = (source: string) =>
  JSON.parse(
    JSON.stringify(parseDmn(source).ast, (k, v: unknown) =>
      k === 'range' || k === 'raw' ? undefined : v,
    ),
  ) as unknown;

describe('DMN parser (#71)', () => {
  it.each([...examples, ...valid])('%s parses without diagnostics', (file) => {
    expect(parseDmn(read(file)).diagnostics.map(at)).toEqual([]);
  });

  it.each(examples)('%s matches its AST snapshot', (file) => {
    expect(shape(read(file))).toMatchSnapshot();
  });

  it('reads header columns: inputs, outputs, types, values and annotations', () => {
    const { ast } = parseDmn(read('examples/dmn/01-loan-approval.dmnt'));
    const table = ast.elements.at(-1)!.logic[0]!;
    expect(table.type).toBe('table');
    if (table.type !== 'table') return;
    expect(
      table.columns.map((c) => [
        c.role,
        c.label.value,
        c.typeRef?.value,
        c.marker,
      ]),
    ).toEqual([
      ['input', 'Credit score', undefined, undefined],
      ['input', 'Loan amount', undefined, undefined],
      ['output', 'Approved', 'boolean', '->'],
      ['output', 'Reason', 'string', undefined],
      ['annotation', 'Notes', undefined, '//'],
    ]);
    expect(table.rows[0]!.cells.map((c) => c.text)).toEqual([
      '>= 700',
      '<= 50000',
      'true',
      '"Good score"',
      'Standard approval',
    ]);
  });

  it('unescapes \\| in cells and keeps cell positions', () => {
    const source =
      'decision X\n  table\n    | a | -> b |\n    | "p\\|q" | 1 |\n';
    const { ast } = parseDmn(source);
    const table = ast.elements[0]!.logic[0]!;
    if (table.type !== 'table') throw new Error('no table');
    const cell = table.rows[0]!.cells[0]!;
    expect(cell.text).toBe('"p|q"');
    expect(source.slice(cell.range.start.offset, cell.range.end.offset)).toBe(
      '"p\\|q"',
    );
  });

  it('recovers per line and per row', () => {
    const { ast, diagnostics } = parseDmn(
      'input A [type: number\ninput B\ndecison C\ndecision D [requires: B]\n  literal B\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(['BT001', 'BT101']);
    expect(ast.elements.map((e) => e.name.value)).toEqual(['B', 'D']);
  });

  it('never throws on random input', () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(
            ...' \n|->/:,[]"\\#@-<>=()decision input table literal doc'.split(
              '',
            ),
          ),
          maxLength: 300,
        }),
        (source) => {
          parseDmn(source);
          checkDmn(source);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never throws on edits of the corpus', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...corpus),
        fc.nat(),
        fc.string({ maxLength: 8 }),
        (file, at, insert) => {
          const source = read(file);
          const i = at % (source.length + 1);
          checkDmn(source.slice(0, i) + insert + source.slice(i));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('DMN formatter (#71)', () => {
  it.each(corpus)('%s: format is idempotent and keeps the AST', (file) => {
    const source = read(file);
    if (parseDmn(source).diagnostics.some((d) => /^BT00/.test(d.code))) return;
    const once = formatDmn(source);
    expect(formatDmn(once)).toBe(once);
    // The formatter only changes how things are written: `-` for an empty
    // input cell, hit policies in full.
    expect(show(checkDmn(once).model)).toEqual(show(checkDmn(source).model));
  });

  it.each(examples)('%s is already formatted', (file) => {
    expect(formatDmn(read(file))).toBe(read(file));
  });

  it('aligns table columns, spaces markers and writes hit policies in full', () => {
    const source = `decision Pass
  table [hit: F]
    |Score|->Pass|//Why|
    | >= 50 | true |good|
    |< 50|false||
`;
    expect(formatDmn(source)).toBe(`decision Pass
  table [hit: first]
    | Score | -> Pass | // Why |
    | >= 50 | true    | good   |
    | < 50  | false   |        |
`);
  });

  it('keeps comments, and writes - for empty input cells', () => {
    const source = `# Rules
input A   # the input

decision B [requires: A]
  # the table
  table
    | A | -> B |
    |   | 1    |
`;
    expect(formatDmn(source)).toBe(`# Rules
input A  # the input

decision B [requires: A]
  # the table
  table
    | A | -> B |
    | - | 1    |
`);
  });

  it('keeps parse(format(x)) equal to parse(x) for generated tables', () => {
    const cell = fc.constantFrom('-', '>= 1', '"a"', 'true', '[1..2]', '');
    fc.assert(
      fc.property(
        fc.array(fc.array(cell, { minLength: 2, maxLength: 2 }), {
          maxLength: 6,
        }),
        fc.constantFrom('', ' [hit: U]', ' [hit: collect sum]'),
        (rows, hit) => {
          const source = `input A\ninput B\ndecision C [requires: A, B]\n  table${hit}\n    | A | B | -> C |\n${rows
            .map((r) => `    |${r.join('|')}| 1 |\n`)
            .join('')}`;
          const once = formatDmn(source);
          expect(formatDmn(once)).toBe(once);
          expect(show(checkDmn(once).model)).toEqual(
            show(checkDmn(source).model),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

/** The model, compactly, for snapshots. */
function show(m: DmnModel) {
  return JSON.parse(
    JSON.stringify(m, (k, v: unknown) =>
      k === 'range' || k.endsWith('Range') || k === 'lines' ? undefined : v,
    ),
  ) as unknown;
}

describe('DMN model builder and validator (#72)', () => {
  it.each(examples)('%s builds with no errors or warnings', (file) => {
    const { diagnostics } = checkDmn(read(file));
    expect(diagnostics.filter((d) => d.severity !== 'info').map(at)).toEqual(
      [],
    );
  });

  it.each(examples)('%s matches its model snapshot', (file) => {
    expect(show(checkDmn(read(file)).model)).toMatchSnapshot();
  });

  it.each(valid)('%s has no diagnostics', (file) => {
    expect(checkDmn(read(file)).diagnostics.map(at)).toEqual([]);
  });

  it.each(diagnosticsFixtures)(
    '%s reports exactly its expected diagnostics',
    (file) => {
      const source = read(file);
      const expected = [
        ...source.matchAll(/^# expect: (BT\d{3}) @ (\d+):(\d+)$/gm),
      ].map((m) => `${m[1]} @ ${m[2]}:${m[3]}`);
      expect(expected.length).toBeGreaterThan(0);
      expect(checkDmn(source).diagnostics.map(at).sort()).toEqual(
        expected.sort(),
      );
    },
  );

  it('gives deterministic IDs', () => {
    const { model } = checkDmn(read('examples/dmn/01-loan-approval.dmnt'));
    expect(model.id).toBe('Definitions_loan_approval');
    expect(model.elements.map((e) => e.id)).toEqual([
      'InputData_credit_score',
      'InputData_loan_amount',
      'BusinessKnowledgeModel_risk_policy',
      'KnowledgeSource_lending_guidelines',
      'Decision_approve_loan',
    ]);
    expect(model.requirements.map((r) => r.id)).toEqual([
      'InformationRequirement_credit_score__approve_loan',
      'InformationRequirement_loan_amount__approve_loan',
      'KnowledgeRequirement_risk_policy__approve_loan',
      'AuthorityRequirement_lending_guidelines__approve_loan',
    ]);
    const decision = model.elements.at(-1)!;
    if (decision.kind !== 'decision' || decision.logic?.type !== 'table')
      throw new Error('no table');
    expect(decision.logic.rules.map((r) => r.id)).toEqual([
      'Rule_approve_loan_1',
      'Rule_approve_loan_2',
      'Rule_approve_loan_3',
    ]);
  });

  it('suggests close names, with quick fixes', () => {
    const fixes = (file: string) =>
      checkDmn(read(file)).diagnostics.flatMap((d) =>
        (d.fixes ?? []).flatMap((f) => f.edits.map((e) => e.newText)),
      );
    expect(
      fixes('test/fixtures/dmn/diagnostics/BT202-unknown-requirement.dmnt'),
    ).toEqual(['Score']);
    expect(
      fixes('test/fixtures/dmn/diagnostics/BT503-unknown-type.dmnt'),
    ).toEqual(['number']);
    expect(
      fixes('test/fixtures/dmn/diagnostics/BT504-unknown-hit-policy.dmnt'),
    ).toEqual(['unique']);
    expect(
      fixes('test/fixtures/dmn/diagnostics/BT522-unknown-name.dmnt'),
    ).toEqual(['Order total']);
    expect(
      fixes('test/fixtures/dmn/diagnostics/BT523-not-allowed-value.dmnt'),
    ).toEqual(['"Winter"']);
    expect(
      fixes('test/fixtures/dmn/diagnostics/BT101-unknown-keyword.dmnt'),
    ).toEqual(['decision']);
  });

  it('offers to pad a short row (BT501)', () => {
    const source =
      'input A\ninput B\ndecision C [requires: A, B]\n  table\n    | A | B | -> C |\n    | 1 | 1 |\n';
    const [d] = checkDmn(source).diagnostics.filter((x) => x.code === 'BT501');
    const edit = d!.fixes![0]!.edits[0]!;
    const fixed =
      source.slice(0, edit.range.start.offset) +
      edit.newText +
      source.slice(edit.range.end.offset);
    expect(checkDmn(fixed).diagnostics.map((x) => x.code)).not.toContain(
      'BT501',
    );
  });

  it('can turn checks off', () => {
    const source = read('test/fixtures/dmn/diagnostics/BT531-gap.dmnt');
    expect(checkDmn(source, { rules: { BT531: false } }).diagnostics).toEqual(
      [],
    );
  });
});

describe('FEEL in cells (#75)', () => {
  it.each([...examples, ...valid])('%s: every cell parses', (file) => {
    const codes = checkDmn(read(file)).diagnostics.map((d) => d.code);
    expect(codes.filter((c) => /^BT52/.test(c))).toEqual([]);
  });

  it('reports the error inside a multi-line literal on its line', () => {
    const { diagnostics } = checkDmn(
      'input A [type: number]\ndecision B [requires: A]\n  literal\n    if A > 1\n    then 2 +\n',
    );
    expect(diagnostics.map(at)).toEqual(['BT520 @ 4:5']);
  });

  it('knows built-in functions and the names of knowledge models', () => {
    const { diagnostics } = checkDmn(
      'input A [type: number]\nknowledge F [params: x]\n  literal x * 2\ndecision B [requires: A, F]\n  literal floor(F(A)) + sum([A, 1]) + string length("x")\n',
    );
    expect(diagnostics).toEqual([]);
  });

  it('does not check names bound inside the expression', () => {
    const { diagnostics } = checkDmn(
      'input L\ndecision B [requires: L]\n  literal for x in L return x * 2\n',
    );
    expect(diagnostics).toEqual([]);
  });
});

describe('table checks (#76)', () => {
  const table = (hit: string, inputs: string[], rows: string[][]) =>
    `${inputs.map((i) => `input ${i} [type: number]`).join('\n')}
decision D [requires: ${inputs.join(', ')}]
  table [hit: ${hit}]
    | ${inputs.join(' | ')} | -> Out |
${rows.map((r) => `    | ${r.join(' | ')} |`).join('\n')}
`;

  it('finds no overlap where intervals only touch', () => {
    const { diagnostics } = checkDmn(
      table(
        'unique',
        ['A'],
        [
          ['< 10', '1'],
          ['[10..20]', '2'],
          ['> 20', '3'],
        ],
      ),
    );
    expect(diagnostics).toEqual([]);
  });

  it('finds overlaps in two dimensions, with the region in the message', () => {
    const { diagnostics } = checkDmn(
      table(
        'unique',
        ['A', 'B'],
        [
          ['< 10', '-', '1'],
          ['>= 5', '> 0', '2'],
          ['>= 10', '<= 0', '3'],
        ],
      ),
    );
    const overlap = diagnostics.find((d) => d.code === 'BT530')!;
    expect(overlap.message).toContain('A in [5..10) and B > 0');
  });

  it('skips entries it cannot reason about, never guessing', () => {
    const { diagnostics } = checkDmn(
      `input A [type: number]
input B [type: number]
decision D [requires: A, B]
  table
    | A     | -> Out |
    | > B   | 1      |
    | <= B  | 2      |
`,
    );
    expect(diagnostics).toEqual([]);
  });

  it('checks a 50-rule, 6-input table in under 50 ms', () => {
    const inputs = ['A', 'B', 'C', 'D', 'E', 'F'];
    const rows = Array.from({ length: 50 }, (_, r) => [
      ...inputs.map((_, c) => `[${r * 10 + c}..${r * 10 + c + 9})`),
      String(r),
    ]);
    const source = table('first', inputs, rows);
    checkDmn(source); // warm up
    const start = performance.now();
    const { diagnostics } = checkDmn(source);
    const took = performance.now() - start;
    expect(diagnostics.map((d) => d.code)).toContain('BT531');
    expect(took).toBeLessThan(process.env.BPMN_TEXT_COVERAGE ? 250 : 50);
  });
});

describe('DMN completion (#79, #82)', () => {
  const data = { names: ['Credit score', 'Loan amount', 'Risk policy'] };
  const labels = (before: string, previous?: string) =>
    suggestDmn(before, data, previous)?.options.map((o) => o.label);

  it('offers keywords at the start of a line', () => {
    expect(labels('dec')).toContain('decision');
    expect(labels('  ta')).toEqual(['doc', 'table', 'literal']);
  });

  it('offers attributes, names, types and hit policies in […]', () => {
    expect(labels('decision A [')).toContain('requires');
    expect(labels('decision A [requires: Cre')).toEqual(data.names);
    expect(labels('decision A [requires: Credit score, ')).toContain(
      'Loan amount',
    );
    expect(labels('decision A [requires: Credit score, ')).toContain('type');
    expect(labels('input A [type: num')).toContain('number');
    expect(labels('  table [hit: ')).toContain('collect sum');
    expect(suggestDmn('decision A [requires: Cre', data)!.from).toBe(22);
  });

  it('offers names and types in a table heading only', () => {
    expect(labels('    | Cre', '  table')).toEqual(data.names);
    expect(labels('    | Credit score | -> Ok: bo', '  table')).toContain(
      'boolean',
    );
    expect(
      labels('    | >= 7', '    | Credit score | -> Ok |'),
    ).toBeUndefined();
  });
});
