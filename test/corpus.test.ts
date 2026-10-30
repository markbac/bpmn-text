import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const list = (dir: string) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.bpmnt'))
    .map((f) => `${dir}/${f}`);

const notation = read('docs/notation.md');
const diagnosticCodes = [...notation.matchAll(/^\| (BT\d{3}) \|/gm)].map(
  (m) => m[1]!,
);
// Sections §4 to §10 and their subsections, from the notation headings.
const sections = [...notation.matchAll(/^#{2,3} (\d+(?:\.\d+)?)\.? /gm)]
  .map((m) => m[1]!)
  .filter((s) => {
    const major = Number(s.split('.')[0]);
    return major >= 4 && major <= 10;
  });

const examples = list('examples');
const valid = list('test/fixtures/valid');
const diagnostics = list('test/fixtures/diagnostics');

function header(path: string) {
  const lines = read(path).split('\n');
  const comments = lines.slice(
    0,
    lines.findIndex((l) => !l.startsWith('#')),
  );
  const expects = comments.flatMap((l) => {
    const m = /^# expect: (BT\d{3}) @ (\d+):(\d+)$/.exec(l);
    return m ? [{ code: m[1]!, line: Number(m[2]), col: Number(m[3]) }] : [];
  });
  const covers = comments.flatMap((l) =>
    l.startsWith('# covers: ')
      ? l
          .slice('# covers: '.length)
          .split(',')
          .map((s) => s.trim().replace(/^§/, ''))
      : [],
  );
  return { lines, comments, expects, covers };
}

describe('corpus', () => {
  it('reads the diagnostic codes and sections from the notation', () => {
    expect(diagnosticCodes.length).toBeGreaterThan(20);
    expect(sections).toContain('4.1');
    expect(sections).toContain('10');
  });

  it.each(diagnosticCodes)('%s has a diagnostics fixture', (code) => {
    const files = diagnostics.filter((f) => basename(f).startsWith(code));
    expect(files).not.toHaveLength(0);
    for (const f of files) {
      expect(header(f).expects.map((e) => e.code)).toContain(code);
    }
  });

  it.each(sections)('§%s is covered by an example or fixture', (section) => {
    const covered = [...examples, ...valid].some((f) =>
      header(f).covers.some(
        (c) => c === section || c.startsWith(`${section}.`),
      ),
    );
    expect(covered).toBe(true);
  });

  it.each([...examples, ...valid, ...diagnostics])(
    '%s has a well-formed header',
    (file) => {
      const { lines, comments, expects, covers } = header(file);
      expect(comments.length).toBeGreaterThan(0);
      for (const c of comments.filter((l) => /^# (expect|covers)\b/.test(l))) {
        expect(c).toMatch(/^# (expect: BT\d{3} @ \d+:\d+|covers: .+)$/);
      }
      for (const s of covers) expect(sections).toContain(s);
      for (const { code, line, col } of expects) {
        expect(diagnosticCodes).toContain(code);
        const text = lines[line - 1];
        expect(text, `line ${line}`).toBeDefined();
        expect(col).toBeLessThanOrEqual(text!.length);
        expect(text![col - 1], `${line}:${col}`).not.toBe(' ');
      }
      if (!file.includes('/diagnostics/')) {
        expect(expects).toHaveLength(0);
        expect(covers).not.toHaveLength(0);
      }
    },
  );
});
