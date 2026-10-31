import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringStream } from '@codemirror/language';
import { describe, expect, it, vi } from 'vitest';
import { compileSource, type Compiled } from '../src/compile.js';
import { Compiler } from '../src/compiler.js';
import { bpmnTextParser, referenceText, suggest } from '../src/language.js';
import { toLint } from '../src/lint.js';
import { fileName, shareHash, sourceFromHash } from '../src/share.js';
import { elementAt } from '../src/sync.js';

const examples = join(import.meta.dirname, '../../../examples');

/** `text` as [token, style] pairs per line, without whitespace. */
function highlight(text: string): string[][] {
  const state = bpmnTextParser.startState!(2);
  return text.split('\n').map((line) => {
    const stream = new StringStream(line, 2, 2);
    const tokens: string[] = [];
    while (!stream.eol()) {
      const style = bpmnTextParser.token(stream, state);
      const token = line.slice(stream.start, stream.pos).trim();
      if (token) tokens.push(`${token}:${style ?? '-'}`);
      stream.start = stream.pos;
    }
    return tokens;
  });
}

describe('highlighter (#39)', () => {
  it('marks keywords, event types, operators, strings, ids and attributes', () => {
    expect(
      highlight(
        'title "Order"\nstart timer Monday @mon [doc: x, color: #FFF]\ntask A -(ok)-> Monday # done',
      ),
    ).toEqual([
      ['title:keyword', '"Order":string'],
      [
        'start:keyword',
        'timer:typeName',
        'Monday:-',
        '@mon:meta',
        '[:bracket',
        'doc:attributeName',
        '::punctuation',
        'x:atom',
        ',:punctuation',
        'color:attributeName',
        '::punctuation',
        '#FFF:atom',
        ']:bracket',
      ],
      [
        'task:keyword',
        'A:-',
        '-(:operator',
        'ok:labelName',
        ')->:operator',
        'Monday:-',
        '# done:comment',
      ],
    ]);
  });

  it('marks branch labels, bullets and inline declarations', () => {
    expect(
      highlight('xor Ok?\n  yes: task Ship -> end Done\n  - task B'),
    ).toEqual([
      ['xor:keyword', 'Ok?:-'],
      [
        'yes:labelName',
        '::punctuation',
        'task:keyword',
        'Ship:-',
        '->:operator',
        'end:keyword',
        'Done:-',
      ],
      ['-:operator', 'task:keyword', 'B:-'],
    ]);
  });

  it('keeps doc text raw, in line and block form', () => {
    expect(
      highlight(
        'doc Uses -> "quotes" # here\ndoc\n  task Not a keyword\n\ntask After',
      ),
    ).toEqual([
      ['doc:keyword', 'Uses -> "quotes" # here:docString'],
      ['doc:keyword'],
      ['task Not a keyword:docString'],
      [],
      ['task:keyword', 'After:-'],
    ]);
  });

  it('reads every example without throwing', () => {
    for (const name of [
      '04-collaboration',
      '06-subprocess-data',
      '07-multi-phase',
    ]) {
      const text = readFileSync(join(examples, `${name}.bpmnt`), 'utf8');
      expect(highlight(text).flat().length).toBeGreaterThan(10);
    }
  });
});

describe('completion (#39)', () => {
  const data = {
    names: ['Check order', 'end of month', 'A, B'],
    lanes: ['Sales'],
  };
  const labels = (before: string) =>
    suggest(before, data)?.options.map((o) => o.label) ?? [];

  it('offers element names after -> and after the commas of a jump', () => {
    expect(labels('task Fix -> ')).toContain('Check order');
    expect(labels('-> Ch')).toContain('Check order');
    expect(labels('-> Check order, ')).toContain('Check order');
    expect(labels('send A ~> ')).toContain('Check order');
    expect(suggest('task Fix -> Ch', data)?.from).toBe(12);
  });

  it('quotes names that would not read back as a reference', () => {
    expect(referenceText('Check order')).toBe('Check order');
    expect(referenceText('end of month')).toBe('"end of month"');
    expect(referenceText('A, B')).toBe('"A, B"');
  });

  it('offers keywords, event types, attributes and lanes', () => {
    expect(labels('  ta')).toContain('task');
    expect(labels('start ')).toEqual([
      'message',
      'timer',
      'signal',
      'conditional',
    ]);
    expect(labels('  on ')).toContain('error');
    expect(labels('task A [lo')).toContain('loop');
    expect(labels('task A [loop, re')).toContain('reads');
    expect(labels('task A [lane: ')).toEqual(['Sales']);
    expect(labels('  lane ')).toEqual(['Sales']);
    expect(suggest('task Check ', data)).toBeUndefined();
  });
});

describe('lint (#38)', () => {
  it('turns diagnostics into ranges with quick-fix actions', async () => {
    const { diagnostics } = await compileSource('start\ntask Fix\n-> Fx\n');
    const d = toLint(diagnostics, 20).find((l) => l.source === 'BT202');
    expect(d).toMatchObject({
      from: 18,
      to: 20,
      severity: 'error',
      source: 'BT202',
    });
    expect(d!.actions!.map((a) => a.name)).toEqual(['Change to `Fix`']);
  });
});

describe('selection sync (#40)', () => {
  it('finds the innermost drawn element at the cursor', async () => {
    const source = readFileSync(
      join(examples, '06-subprocess-data.bpmnt'),
      'utf8',
    );
    const { sourceMap } = await compileSource(source);
    const at = (text: string) => elementAt(sourceMap, source.indexOf(text));
    expect(at('Calculate totals')).toBe('Activity_calculate_totals');
    expect(at('Create invoices')).toBe('Activity_create_invoices');
    expect(at('Includes contractors')).toBe(
      'TextAnnotation_collect_billable_hours',
    );
    // The data reference that is drawn, not the data object.
    expect(
      elementAt(
        sourceMap,
        source.indexOf('Hours report'),
        (id) => !id.startsWith('DataObject_'),
      ),
    ).toBe('DataObjectReference_hours_report');
  });
});

describe('share links and files (#41)', () => {
  it('round-trips any source through the URL hash', () => {
    const source = 'title "Ünïcode ✓"\nstart\n  task "A -> B" # note\nend\n';
    expect(sourceFromHash(shareHash(source))).toBe(source);
    expect(sourceFromHash('#other')).toBeUndefined();
  });

  it('names downloads after the title', () => {
    expect(fileName('title "Order fulfilment"\nstart\n')).toBe(
      'order-fulfilment',
    );
    expect(fileName('start\n')).toBe('diagram');
  });
});

describe('compiler (#38)', () => {
  it('debounces, runs one compile at a time and skips stale text', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const port = {
      onmessage: null as
        ((e: MessageEvent<Compiled & { id: number }>) => void) | null,
      postMessage: (m: { source: string }) => sent.push(m.source),
    };
    const results: string[] = [];
    const compiler = new Compiler(port, (_, source) => results.push(source));
    compiler.update('a');
    compiler.update('ab');
    vi.advanceTimersByTime(150);
    expect(sent).toEqual(['ab']);
    compiler.update('abc', true);
    compiler.update('abcd', true);
    expect(sent).toEqual(['ab']);
    port.onmessage!({ data: { id: 0 } } as MessageEvent<
      Compiled & { id: number }
    >);
    expect(results).toEqual(['ab']);
    expect(sent).toEqual(['ab', 'abcd']);
    vi.useRealTimers();
  });

  it('updates a 60-element diagram in well under 200 ms (NFR-4)', async () => {
    const lines = ['start'];
    for (let i = 0; i < 20; i++) {
      lines.push(
        `task Step ${i}`,
        `xor Check ${i}?`,
        `  yes: task Fine ${i}`,
        `  no: task Fix ${i}`,
      );
    }
    lines.push('end');
    const source = `${lines.join('\n')}\n`;
    await compileSource(source); // warm up
    // The best of five, so that other tests running at the same time do
    // not decide the result.
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await compileSource(source));
    expect(runs[0]!.diagnostics.filter((d) => d.severity !== 'info')).toEqual(
      [],
    );
    expect(Math.min(...runs.map((r) => r.ms))).toBeLessThan(200);
  });
});
