import { readFileSync, readdirSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { format } from '../src/formatter.js';
import { parse } from '../src/parser.js';

/** The AST without positions or quoting, which formatting may change. */
function shape(source: string): unknown {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k !== 'range' && k !== 'quoted') out[k] = strip(v);
    }
    return out;
  };
  return strip(parse(source).ast);
}
const comments = (source: string) => parse(source).comments.map((c) => c.text);

const root = new URL('../../../', import.meta.url);
const corpus = [
  'examples/',
  'test/fixtures/valid/',
  'test/fixtures/diagnostics/',
].flatMap((dir) =>
  readdirSync(new URL(dir, root))
    .filter((f) => f.endsWith('.bpmnt'))
    .map((f) => `${dir}${f}`),
);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');

describe('formatter (#16)', () => {
  it('prints canonical spacing and indentation', () => {
    expect(
      format(
        'pool  P\n    start   ->task A-(ok)->   end  B\n    task   C [ loop ,reads:X,Y ]\n',
      ),
    ).toBe(
      'pool P\n  start -> task A -(ok)-> end B\n  task C [loop, reads: X, Y]\n',
    );
  });

  it('quotes names only where a bare name would read back differently', () => {
    const source = [
      'start "message received"', // an event type word would become the type
      'task "Check -> reserve"',
      'task "Line one\\nLine two"',
      'task Pick, pack: ship', // commas and colons are fine in element names
      'xor "Ok?"',
      '  "yes: really":',
      '    -> "end of month", "A, B"', // keyword-first and comma names in references
      '  "else": end X',
      'task end of month',
      'task A, B',
      'data D [doc: "a, b", color: #1F4E79]',
      '',
    ].join('\n');
    expect(format(source)).toBe(source.replace('xor "Ok?"', 'xor Ok?'));
  });

  it('keeps every comment, in place', () => {
    const source =
      '# head\n\npool P  # trailing\n  start\n  # inside\n  task A\n    # deeper\n  end\n# tail\n';
    expect(format(source)).toBe(
      '# head\n\npool P  # trailing\n  start\n  # inside\n  task A\n  # deeper\n  end\n# tail\n',
    );
  });

  it('keeps one blank line where the source had any', () => {
    expect(format('start\n\n\n\ntask A\nend\n')).toBe('start\n\ntask A\nend\n');
  });

  it('prints doc text in line and block form', () => {
    const source = 'task A\ndoc raw -> text # kept\ndoc\n  one\n\n  two\n';
    expect(format(source)).toBe(source);
  });

  it('returns source with syntax errors unchanged', () => {
    const source = 'start\ntaks   A\nend\n';
    expect(format(source)).toBe(source);
  });

  it.each(corpus)(
    '%s: is idempotent and keeps the AST and comments',
    (file) => {
      const source = read(file);
      const once = format(source);
      expect(format(once)).toBe(once);
      if (!parse(source).diagnostics.some((d) => d.severity === 'error')) {
        expect(shape(once)).toEqual(shape(source));
      }
      expect(comments(once)).toEqual(comments(source));
    },
  );

  it('is idempotent and keeps the AST on mutated examples', () => {
    const examples = corpus.filter((f) => f.startsWith('examples/')).map(read);
    fc.assert(
      fc.property(
        fc.constantFrom(...examples),
        fc.nat(),
        fc.string({
          unit: fc.constantFrom(...' \n-:,#"xortask->[]'.split('')),
          maxLength: 12,
        }),
        (example, at, insert) => {
          const i = at % (example.length + 1);
          const source = example.slice(0, i) + insert + example.slice(i);
          const once = format(source);
          expect(format(once)).toBe(once);
          expect(comments(once)).toEqual(comments(source));
          if (once !== source) expect(shape(once)).toEqual(shape(source));
        },
      ),
      { numRuns: 300 },
    );
  });
});
