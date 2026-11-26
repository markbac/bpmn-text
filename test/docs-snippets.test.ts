import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile, compileDmn, parse } from 'bpmn-text';
import { describe, expect, it } from 'vitest';

// Every ```bpmnt and ```dmnt block in the documentation must compile
// without errors (#48, #81, NFR-7). A block after
// `<!-- expect-error BTxxx -->` (or `expect-warning`) must instead report
// that code; several codes may be listed, separated by spaces. A block after
// `<!-- fragment -->` is an excerpt that refers to elements it does not
// show, so it only has to parse.
const root = join(import.meta.dirname, '..');
const files = [
  'README.md',
  ...readdirSync(join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];

interface Snippet {
  language: 'bpmnt' | 'dmnt';
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
    const open = /^(\s*)```(bpmnt|dmnt)\s*$/.exec(lines[i]!);
    if (!open) continue;
    const indent = open[1]!.length;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]!); j++) {
      body.push(lines[j]!.slice(indent));
    }
    let k = i - 1;
    while (k >= 0 && lines[k]!.trim() === '') k--;
    const marker = /<!-- expect-(?:error|warning) ((?:BT\d{3}\s*)+)-->/.exec(
      lines[k] ?? '',
    );
    found.push({
      language: open[2] as 'bpmnt' | 'dmnt',
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

describe('documentation pictures (#93)', () => {
  const pictures = files.flatMap((file) => {
    const text = readFileSync(join(root, file), 'utf8');
    return [
      ...text.matchAll(/<!-- screenshot: ([\w-]+) -->\s*```(?:bpmnt|dmnt)/g),
    ].map((m) => [`${file}: ${m[1]!}`, text, m[1]!] as const);
  });

  it.each(pictures)('%s is rendered and shown', (_, text, name) => {
    expect(existsSync(join(root, `docs/images/${name}.png`))).toBe(true);
    expect(text).toContain(`images/${name}.png)`);
  });
});

describe('notation reference (#93)', () => {
  const text = readFileSync(join(root, 'docs/notation.md'), 'utf8');
  const parts = text.split(/^(?=#{2,4} )/m);
  // Sections 4 to 10, leaving out those with only subsections under them.
  const leaves = parts.flatMap((part, i) => {
    const m = /^#{2,3} (\d+)(\.\d+)?\.? /.exec(part);
    if (!m || Number(m[1]) < 4 || Number(m[1]) > 10) return [];
    const parent = !m[2] && parts[i + 1]?.startsWith(`### ${m[1]}.1`);
    return parent && !part.includes('screenshot') ? [] : [[part] as const];
  });

  it('finds the sections', () => {
    expect(leaves.length).toBeGreaterThan(20);
  });

  it.each(leaves)('has a rendered example: %s', (part) => {
    expect(part).toContain('<!-- screenshot: ');
  });

  const codes = [...text.matchAll(/^\| (BT\d{3}) \|/gm)].map((m) => m[1]!);

  it.each(codes)('%s has an example, a fix and a fixture', (code) => {
    const entry = parts.find((p) => p.startsWith(`#### ${code}\n`));
    expect(entry, 'heading').toBeDefined();
    expect(entry).toContain(`<!-- expect-error ${code} -->`);
    expect(entry).toContain('Fix');
    const fixture = /\]\(\.\.\/(test\/fixtures\/diagnostics\/[^)]+)\)/.exec(
      entry!,
    );
    expect(fixture, 'fixture link').not.toBeNull();
    expect(fixture![1]).toContain(code);
    expect(existsSync(join(root, fixture![1]!))).toBe(true);
  });
});

describe('DMN notation reference (#81)', () => {
  const text = readFileSync(join(root, 'docs/dmn-notation.md'), 'utf8');
  const parts = text.split(/^(?=#{2,4} )/m);
  const codes = [...text.matchAll(/^\| (BT5\d{2}) \|/gm)].map((m) => m[1]!);

  it('finds the codes', () => {
    expect(codes.length).toBeGreaterThan(15);
  });

  it.each(codes)('%s has an example and a fixture', (code) => {
    const entry = parts.find((p) => p.startsWith(`#### ${code}\n`));
    expect(entry, 'heading').toBeDefined();
    const fixture = /\]\(\.\.\/(test\/fixtures\/dmn\/[^)]+)\)/.exec(entry!);
    expect(fixture, 'fixture link').not.toBeNull();
    expect(fixture![1]).toContain(code);
    expect(existsSync(join(root, fixture![1]!))).toBe(true);
    if (code !== 'BT540')
      expect(entry).toMatch(
        new RegExp(`<!-- expect-(error|warning) ${code} -->`),
      );
  });
});

describe('documentation snippets', () => {
  it('finds the snippets', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it.each(all.map((s) => [`${s.file}:${s.line}`, s] as const))(
    '%s compiles',
    async (_, { language, source, expect: codes, fragment }) => {
      if (language === 'dmnt') {
        const { diagnostics, xml } = await compileDmn(source);
        if (codes.length === 0) {
          // Clean examples have no warnings either.
          expect(
            diagnostics
              .filter((d) => d.severity !== 'info')
              .map((d) => `${d.code} @ ${d.range.start.line}: ${d.message}`),
          ).toEqual([]);
          expect(xml).toContain('<dmndi:DMNDiagram');
        } else {
          expect(diagnostics.map((d) => d.code)).toEqual(
            expect.arrayContaining(codes),
          );
        }
        return;
      }
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
