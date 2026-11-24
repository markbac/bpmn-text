import { describe, expect, it } from 'vitest';
import {
  complete,
  definition,
  formatted,
  hover,
  references,
  rename,
  symbols,
} from '../src/analysis.js';

const source = `title Orders
pool Shop
  lane Sales
  start
  task Take order @take [doc: Enter the order]
  xor Paid?
    yes: task Ship [lane: Warehouse]
      end
    no:
      -> Take order
  lane Warehouse
`;

const at = (needle: string, nth = 0) => {
  let from = -1;
  for (let i = 0; i <= nth; i++) from = source.indexOf(needle, from + 1);
  return from + 1;
};
const text = (s: { start: number; end: number }) =>
  source.slice(s.start, s.end);

describe('symbols', () => {
  it('nests elements under their pool and gateway', () => {
    const [pool] = symbols(source);
    expect(pool).toMatchObject({ name: 'Shop', kind: 'pool' });
    const names = pool!.children.map((c) => c.name);
    expect(names).toContain('Sales');
    expect(names).toContain('Take order');
    const gateway = pool!.children.find((c) => c.name === 'Paid?');
    expect(gateway?.children.map((c) => c.name)).toContain('Ship');
  });
});

describe('navigation', () => {
  it('goes from a name reference to its declaration', () => {
    const [target] = definition(source, at('-> Take order') + 3);
    expect(target).toBeDefined();
    expect(target!.start).toBeLessThan(at('-> Take order'));
    expect(text(target!)).toBe('Take order');
  });

  it('finds the declaration and the references of a name', () => {
    const spans = references(source, at('Take order'));
    expect(spans.map(text)).toEqual(['Take order', '@take', 'Take order']);
  });

  it('goes to nothing from a declaration', () => {
    expect(definition(source, at('task Take order') + 6)).toEqual([]);
  });

  it('resolves a lane in an attribute', () => {
    const [target] = definition(source, at('lane: Warehouse') + 8);
    expect(text(target!)).toBe('Warehouse');
  });
});

describe('rename', () => {
  it('renames the declaration and every reference by name', () => {
    const found = rename(source, at('Take order'), 'Receive order')!;
    expect(found.placeholder).toBe('Take order');
    expect(found.edits).toHaveLength(2);
    expect(found.edits.every((e) => e.newText === 'Receive order')).toBe(true);
  });

  it('quotes a new name that needs it', () => {
    const found = rename(source, at('Take order'), 'A, B')!;
    expect(found.edits[0]!.newText).toBe('"A, B"');
  });

  it('is undefined off a name', () => {
    expect(rename(source, at('title'), 'x')).toBeUndefined();
  });

  it('refuses a name another element has', () => {
    const found = rename(source, at('Take order'), 'ship')!;
    expect(found.error).toContain('already the name');
    expect(found.edits).toEqual([]);
  });

  it('refuses an empty name', () => {
    expect(rename(source, at('Take order'), '  ')!.error).toContain('empty');
  });
});

describe('data objects', () => {
  const data = [
    'data Invoice (draft)',
    'start',
    'task Draft [writes: Invoice (draft)]',
    'task Approve [reads: Invoice (draft), writes: Invoice (approved)]',
    'task File [reads: "Invoice (copy)"]',
    'end',
    '',
  ].join('\n');
  const after = (s: string, from = 0) => data.indexOf(s, from) + 1;

  it('goes from a use in reads: to the data line', () => {
    const [target] = definition(data, after('Invoice (approved)'));
    expect(data.slice(target!.start, target!.end)).toBe('Invoice');
    expect(target!.start).toBe(data.indexOf('Invoice'));
  });

  it('finds every use, in any state, but not a quoted name', () => {
    expect(references(data, after('Invoice'))).toHaveLength(4);
  });

  it('renames the name and keeps each state', () => {
    const found = rename(data, after('Invoice'), 'Bill')!;
    expect(found.edits).toHaveLength(4);
    let out = data;
    for (const e of [...found.edits].sort(
      (a, b) => b.range.start - a.range.start,
    ))
      out = out.slice(0, e.range.start) + e.newText + out.slice(e.range.end);
    expect(out).toContain('writes: Bill (draft)]');
    expect(out).toContain('writes: Bill (approved)]');
    expect(out).toContain('"Invoice (copy)"');
  });

  it('refuses a new name that would read as a state', () => {
    expect(rename(data, after('Invoice'), 'Bill (x)')!.error).toContain(
      'state',
    );
  });

  it('gives a hover for data', () => {
    expect(hover(data, after('Invoice (approved)'))!.markdown).toContain(
      '**data** Invoice',
    );
  });

  it('leaves data out of the names offered after an arrow', () => {
    const names = complete(`${data}x -> `, data.length + 5)!.options.map(
      (o) => o.label,
    );
    expect(names).not.toContain('Invoice');
  });
});

describe('hover', () => {
  it('gives the type, lane and documentation', () => {
    const found = hover(source, at('Take order'))!;
    expect(found.markdown).toContain('task');
    expect(found.markdown).toContain('Enter the order');
  });

  it('gives the lane of an element declared in one', () => {
    const found = hover(source, at('Ship'))!;
    expect(found.markdown).toContain('Lane: Warehouse');
  });
});

describe('completion', () => {
  it('offers element names after an arrow', () => {
    const line = '      -> Ta';
    const text = source.replace('      -> Take order', line);
    const result = complete(text, text.indexOf(line) + line.length)!;
    expect(result.options.map((o) => o.label)).toContain('Take order');
    expect(text.slice(result.from, result.from + 2)).toBe('Ta');
  });

  it('offers event types after an event keyword', () => {
    const result = complete('start ', 6)!;
    expect(result.options.map((o) => o.label)).toContain('message');
  });

  it('offers nothing in the middle of a name', () => {
    expect(complete('task Check ', 11)).toBeUndefined();
  });
});

describe('formatting', () => {
  it('returns nothing for a formatted document', () => {
    expect(formatted(formatted(source) ?? source)).toBeUndefined();
  });

  it('returns the formatted text otherwise', () => {
    expect(formatted('task   A\n')).toBeDefined();
  });
});
