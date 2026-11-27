import { describe, expect, it } from 'vitest';
import {
  decisionAt,
  decisionDeclaration,
  dmnComplete,
  dmnDefinition,
  dmnFormatted,
  dmnHover,
  dmnReferences,
  dmnRename,
  dmnSymbols,
} from '../src/dmn-analysis.js';

const source = `input Credit score [type: number, doc: "From the bureau"]
knowledge Policy

decision Approve [requires: Credit score, Policy]
  doc Whether to lend.
  table [hit: first]
    | Credit score | -> Ok: boolean |
    | >= 700       | true           |
    | -            | false          |
`;
const at = (needle: string, nth = 0) => {
  let from = -1;
  for (let i = 0; i <= nth; i++) from = source.indexOf(needle, from + 1);
  return from + 1;
};
const text = (s: { start: number; end: number }) =>
  source.slice(s.start, s.end);

describe('DMN in the language server (#82)', () => {
  it('lists elements with their logic as symbols', () => {
    const symbols = dmnSymbols(source);
    expect(symbols.map((s) => [s.name, s.detail])).toEqual([
      ['Credit score', 'Input data'],
      ['Policy', 'Business knowledge model'],
      ['Approve', 'Decision'],
    ]);
    expect(symbols[2]!.children.map((c) => [c.name, c.detail])).toEqual([
      ['table', '2 rules'],
    ]);
  });

  it('goes from a requirement or a heading to the element', () => {
    for (const offset of [at('Credit score', 1), at('Credit score', 2)])
      expect(dmnDefinition(source, offset).map(text)).toEqual(['Credit score']);
    expect(dmnDefinition(source, at('Credit score'))).toEqual([]);
  });

  it('finds every use of a name', () => {
    expect(dmnReferences(source, at('Credit score')).length).toBe(3);
  });

  it('hovers with kind, type, documentation and the table', () => {
    expect(dmnHover(source, at('Credit score', 1))!.markdown).toBe(
      '**Input data** Credit score\n\nType: `number`\n\n\n\nFrom the bureau',
    );
    const decision = dmnHover(source, at('Approve'))!.markdown;
    expect(decision).toContain('Decision table, 2 rules, hit policy first');
    expect(decision).toContain('Whether to lend.');
    expect(dmnHover(source, at('-> Ok') + 3)!.markdown).toBe(
      '**Output column** Ok\n\nType: `boolean`',
    );
  });

  it('renames an element, its requirements and its headings', () => {
    const result = dmnRename(source, at('Credit score'), 'Score, latest')!;
    expect(result.edits.map((e) => e.newText)).toEqual([
      '"Score, latest"',
      '"Score, latest"',
      'Score, latest',
    ]);
    expect(dmnRename(source, at('Credit score'), 'Policy')!.error).toContain(
      'already called',
    );
  });

  it('completes, and formats with aligned tables', () => {
    const offset = source.indexOf('Policy]') + 3;
    expect(dmnComplete(source, offset)?.options.map((o) => o.label)).toContain(
      'Policy',
    );
    expect(dmnFormatted(source)).toBeUndefined();
    expect(
      dmnFormatted(
        'input A\ndecision B [requires: A]\n  table\n    |A|->B|\n    |1|2|\n',
      ),
    ).toContain('| A | -> B |');
  });

  it('reads the decision a BPMN rule task names', () => {
    const bpmn = 'rule Decide [doc: x, decision: loans.dmnt#Approve loan]\n';
    expect(decisionAt(bpmn, bpmn.indexOf('Approve') + 2)).toMatchObject({
      name: 'Approve loan',
      file: 'loans.dmnt',
    });
    expect(decisionAt(bpmn, 2)).toBeUndefined();
    expect(text(decisionDeclaration(source, 'Approve')!)).toBe('Approve');
  });
});
