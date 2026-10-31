import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile, parse } from 'bpmn-text';
import { describe, expect, it } from 'vitest';

// Every ```bpmnt block in the documentation must compile without errors
// (#48, NFR-7). A block after `<!-- expect-error BTxxx -->` must instead
// report that code; several codes may be listed, separated by spaces. A
// block after `<!-- fragment -->` is an excerpt that refers to elements it
// does not show, so it only has to parse.
const root = join(import.meta.dirname, '..');
const files = [
  'README.md',
  ...readdirSync(join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];

interface Snippet {
  file: string;
  line: number;
  source: string;
  expect: string[];
  fragment: boolean;
}

export function snippets(file: string, text: string): Snippet[] {
  const lines = text.split('\n');
  const found: Snippet[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)```bpmnt\s*$/.exec(lines[i]!);
    if (!open) continue;
    const indent = open[1]!.length;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]!); j++) {
      body.push(lines[j]!.slice(indent));
    }
    let k = i - 1;
    while (k >= 0 && lines[k]!.trim() === '') k--;
    const marker = /<!-- expect-error ((?:BT\d{3}\s*)+)-->/.exec(
      lines[k] ?? '',
    );
    found.push({
      file,
      line: i + 1,
      source: `${body.join('\n')}\n`,
      expect: marker ? marker[1]!.trim().split(/\s+/) : [],
      fragment: (lines[k] ?? '').includes('<!-- fragment -->'),
    });
    i = j;
  }
  return found;
}

const all = files.flatMap((file) => {
  let text: string;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    return [];
  }
  return snippets(file, text);
});

describe('documentation snippets', () => {
  it('finds the snippets', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it.each(all.map((s) => [`${s.file}:${s.line}`, s] as const))(
    '%s compiles',
    async (_, { source, expect: codes, fragment }) => {
      if (fragment) {
        expect(parse(source).diagnostics).toEqual([]);
        return;
      }
      const { diagnostics, xml } = await compile(source);
      const errors = diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `${d.code} @ ${d.range.start.line}: ${d.message}`);
      if (codes.length === 0) {
        expect(errors).toEqual([]);
        expect(xml).toContain('<bpmndi:BPMNDiagram');
      } else {
        expect(diagnostics.map((d) => d.code)).toEqual(
          expect.arrayContaining(codes),
        );
      }
    },
  );
});
