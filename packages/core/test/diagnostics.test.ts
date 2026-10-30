import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diagnostic, diagnosticCodes } from '../src/diagnostics.js';
import { didYouMean, editDistance } from '../src/suggest.js';

describe('diagnostic code registry', () => {
  it('matches the table in notation §11', () => {
    const notation = readFileSync(
      new URL('../../../docs/notation.md', import.meta.url),
      'utf8',
    );
    const table = [
      ...notation.matchAll(/^\| (BT\d{3}) \| (\w+) \| (.*) \|$/gm),
    ].map(([, code, severity, meaning]) => [code, { severity, meaning }]);
    expect(table.length).toBeGreaterThan(20);
    expect(Object.fromEntries(table)).toEqual(diagnosticCodes);
  });

  it('gives a diagnostic its default severity', () => {
    const at = { line: 1, col: 1, offset: 0 };
    const range = { start: at, end: at };
    expect(diagnostic('BT103', 'Unknown attribute "x"', range).severity).toBe(
      'warning',
    );
    expect(diagnostic('BT303', 'No end event', range).severity).toBe('info');
  });
});

describe('editDistance', () => {
  it.each([
    ['', '', 0],
    ['task', 'task', 0],
    ['taks', 'task', 1], // transposition
    ['tsk', 'task', 1], // insertion
    ['tasks', 'task', 1], // deletion
    ['tusk', 'task', 1], // substitution
    ['kitten', 'sitting', 3],
  ])('%s → %s is %i', (a, b, distance) => {
    expect(editDistance(a, b)).toBe(distance);
    expect(editDistance(b, a)).toBe(distance);
  });
});

describe('didYouMean', () => {
  const keywords = [
    'start',
    'end',
    'task',
    'user',
    'service',
    'send',
    'receive',
  ];

  it('suggests the closest candidate', () => {
    expect(didYouMean('taks', keywords)).toBe('task');
    expect(didYouMean('servce', keywords)).toBe('service');
    expect(didYouMean('Recieve', keywords)).toBe('receive');
  });

  it('suggests nothing when no candidate is close', () => {
    expect(didYouMean('approve', keywords)).toBeUndefined();
    expect(didYouMean('x', [])).toBeUndefined();
  });
});
