import { readFileSync, readdirSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lex, type Token } from '../src/lexer.js';

/** One token per entry: `line:col kind value`, without zero-width noise. */
const show = (tokens: Token[]) =>
  tokens.map((t) => {
    const at = `${t.range.start.line}:${t.range.start.col}`;
    return t.value
      ? `${at} ${t.kind} ${JSON.stringify(t.value)}`
      : `${at} ${t.kind}`;
  });
const tokens = (source: string) => show(lex(source).tokens);

describe('lexer', () => {
  it('splits element lines into text runs, ids, attributes and flows', () => {
    expect(
      tokens('task Check order @check [loop, reads: A, B] -> end Done'),
    ).toEqual([
      '1:1 text "task Check order"',
      '1:18 id "check"',
      '1:25 op "["',
      '1:26 text "loop"',
      '1:30 op ","',
      '1:32 text "reads"',
      '1:37 op ":"',
      '1:39 text "A"',
      '1:40 op ","',
      '1:42 text "B"',
      '1:43 op "]"',
      '1:45 op "->"',
      '1:48 text "end Done"',
      '1:56 newline',
      '1:56 eof',
    ]);
  });

  it('reads flow labels up to their closing operator', () => {
    expect(tokens('task A -(after review)-> B ~(invoice: 2)~> Bank')).toEqual([
      '1:1 text "task A"',
      '1:8 op "-("',
      '1:10 text "after review"',
      '1:22 op ")->"',
      '1:26 text "B"',
      '1:28 op "~("',
      '1:30 text "invoice: 2"',
      '1:40 op ")~>"',
      '1:44 text "Bank"',
      '1:48 newline',
      '1:48 eof',
    ]);
  });

  it('treats ":" as an operator only before whitespace or the end of the line', () => {
    expect(tokens('yes: task Ratio 3:1\nelse:')).toEqual([
      '1:1 text "yes"',
      '1:4 op ":"',
      '1:6 text "task Ratio 3:1"',
      '1:20 newline',
      '2:1 text "else"',
      '2:5 op ":"',
      '2:6 newline',
      '2:6 eof',
    ]);
  });

  it('reads a leading "-" as a branch bullet, and "-" elsewhere as text', () => {
    expect(tokens('- task Auto-assess\n-')).toEqual([
      '1:1 op "-"',
      '1:3 text "task Auto-assess"',
      '1:19 newline',
      '2:1 op "-"',
      '2:2 newline',
      '2:2 eof',
    ]);
  });

  it('decodes string escapes', () => {
    const [string] = lex(String.raw`"a \"b\" \\ c\nd \x"`).tokens;
    expect(string).toMatchObject({
      kind: 'string',
      value: 'a "b" \\ c\nd \\x',
    });
  });

  it('keeps comments as trivia, but not "#" in attributes or names', () => {
    const result = lex('# heading\ntask A#1 [color: #1F4E79] # trailing\n');
    expect(show(result.tokens)).toEqual([
      '2:1 text "task A#1"',
      '2:10 op "["',
      '2:11 text "color"',
      '2:16 op ":"',
      '2:18 text "#1F4E79"',
      '2:25 op "]"',
      '2:37 newline',
      '3:1 eof',
    ]);
    expect(
      result.comments.map((c) => [
        c.text,
        c.range.start.line,
        c.range.start.col,
      ]),
    ).toEqual([
      ['# heading', 1, 1],
      ['# trailing', 2, 27],
    ]);
  });

  it('emits indent and dedent tokens and ignores blank lines', () => {
    expect(tokens('pool P\n  start\n\n    end\n  x\ny')).toEqual([
      '1:1 text "pool P"',
      '1:7 newline',
      '2:3 indent',
      '2:3 text "start"',
      '2:8 newline',
      '4:5 indent',
      '4:5 text "end"',
      '4:8 newline',
      '5:3 dedent',
      '5:3 text "x"',
      '5:4 newline',
      '6:1 dedent',
      '6:1 text "y"',
      '6:2 newline',
      '6:2 eof',
    ]);
  });

  it('reports tabs (BT002) and then counts each as two spaces', () => {
    const result = lex('pool P\n\tstart\n  end');
    expect(
      result.diagnostics.map((d) => [
        d.code,
        d.range.start.line,
        d.range.start.col,
      ]),
    ).toEqual([['BT002', 2, 1]]);
    expect(show(result.tokens).filter((t) => /indent|dedent/.test(t))).toEqual([
      '2:2 indent',
      '3:6 dedent', // at the end of the file: lines 2 and 3 share a level
    ]);
  });

  it('reports an inconsistent dedent (BT003) and keeps the line in the inner block', () => {
    const result = lex('pool P\n    start\n  end\nx');
    expect(
      result.diagnostics.map((d) => [
        d.code,
        d.range.start.line,
        d.range.start.col,
      ]),
    ).toEqual([['BT003', 3, 3]]);
    expect(show(result.tokens).filter((t) => /indent|dedent/.test(t))).toEqual([
      '2:5 indent',
      '4:1 dedent',
    ]);
  });

  it('reports an unterminated string (BT004) at its opening quote', () => {
    const result = lex('task "Check order');
    expect(result.diagnostics.map((d) => [d.code, d.range.start.col])).toEqual([
      ['BT004', 6],
    ]);
    expect(result.tokens[1]).toMatchObject({
      kind: 'string',
      value: 'Check order',
    });
  });

  it('reads doc text raw, in line and block form', () => {
    expect(tokens('doc a -> b # c\ndoc\n  one\n\n  two\n\ntask X')).toEqual([
      '1:1 text "doc"',
      '1:5 raw "a -> b # c"',
      '1:15 newline',
      '2:1 text "doc"',
      '2:4 newline',
      '3:3 raw "one"',
      '4:1 raw',
      '5:3 raw "two"',
      '7:1 text "task X"',
      '7:7 newline',
      '7:7 eof',
    ]);
  });

  it('accepts CRLF line endings with the same positions', () => {
    const lf = lex('pool P\n  task A\n');
    const crlf = lex('pool P\r\n  task A\r\n');
    const strip = (r: typeof lf) =>
      r.tokens.map((t) => [
        t.kind,
        t.value,
        t.range.start.line,
        t.range.start.col,
      ]);
    expect(strip(crlf)).toEqual(strip(lf));
    expect(crlf.tokens[3]!.range.start.offset).toBe(10);
  });

  it('never throws, and every token lies within the source', () => {
    const alphabet = fc.constantFrom(
      ...' \t\n\r-~>()[]:,@#"\\\\ataskxor'.split(''),
    );
    fc.assert(
      fc.property(
        fc.string({ unit: alphabet, maxLength: 200 }),
        fc.string({ maxLength: 100 }),
        (a, b) => {
          for (const source of [a, b]) {
            const result = lex(source);
            for (const t of result.tokens) {
              expect(t.range.start.offset).toBeLessThanOrEqual(
                t.range.end.offset,
              );
              expect(t.range.end.offset).toBeLessThanOrEqual(source.length);
            }
            expect(result.tokens.at(-1)!.kind).toBe('eof');
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('lexer on the examples', () => {
  const dir = new URL('../../../examples/', import.meta.url);
  it.each(readdirSync(dir).filter((f) => f.endsWith('.bpmnt')))(
    '%s',
    (file) => {
      const result = lex(readFileSync(new URL(file, dir), 'utf8'));
      expect(result.diagnostics).toEqual([]);
      expect(show(result.tokens)).toMatchSnapshot();
    },
  );
});
