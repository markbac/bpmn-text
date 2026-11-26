import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { checkDrdLayout, type DrdLayoutReport } from '@bpmn-text/dmn';
import {
  closeBrowser,
  expectDmnJsImport,
  expectDmnModdleImport,
  expectDmnSchemaValid,
} from '@bpmn-text/test-utils';
import { compileDmn } from 'bpmn-text';
import { afterAll, describe, expect, it } from 'vitest';

afterAll(closeBrowser);

// The DMN examples and fixtures (#81): golden .dmn files next to each
// example (run `npx vitest run test/dmn.test.ts -u` to accept a change),
// validity, layout baselines, and the fixture header conventions.
const root = join(import.meta.dirname, '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const list = (dir: string) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.dmnt'))
    .map((f) => `${dir}/${f}`);

const examples = list('examples/dmn');
const valid = list('test/fixtures/dmn/valid');
const diagnostics = list('test/fixtures/dmn/diagnostics');
const update = process.env.UPDATE_LAYOUT_BASELINES === '1';

const notation = read('docs/dmn-notation.md');
const codes = [...notation.matchAll(/^\| (BT5\d{2}) \|/gm)].map((m) => m[1]!);
const sections = [...notation.matchAll(/^#{2,3} (\d+(?:\.\d+)?)\.? /gm)]
  .map((m) => m[1]!)
  .filter((s) => Number(s.split('.')[0]) <= 6);

describe.each(examples)('DMN golden: %s', (file) => {
  const name = file.replace(/\.dmnt$/, '');
  const result = compileDmn(read(file));

  it('compiles without errors or warnings', async () => {
    const { diagnostics } = await result;
    expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
  });

  it('matches the golden DMN file', async () => {
    const { xml } = await result;
    await expect(xml).toMatchFileSnapshot(join(root, `${name}.dmn`));
  });

  it('meets the layout invariants and its baseline', async () => {
    const { model, layout } = await result;
    const { problems, ...metrics } = checkDrdLayout(model, layout);
    expect(problems).toEqual([]);
    const baseline = join(
      root,
      `test/fixtures/layout/dmn-${basename(name)}.json`,
    );
    if (update || !existsSync(baseline)) {
      writeFileSync(baseline, `${JSON.stringify(metrics, null, 2)}\n`);
      return;
    }
    const stored = JSON.parse(readFileSync(baseline, 'utf8')) as Omit<
      DrdLayoutReport,
      'problems'
    >;
    for (const k of Object.keys(stored) as (keyof typeof stored)[]) {
      const slack = k === 'area' || k === 'edgeLength' ? 1.05 : 1;
      expect(metrics[k], k).toBeLessThanOrEqual(stored[k] * slack);
    }
  });

  it('validates and imports cleanly', async () => {
    const { xml } = await result;
    await expectDmnSchemaValid(xml);
    await expectDmnModdleImport(xml);
    await expectDmnJsImport(xml);
  });
});

describe('DMN fixtures', () => {
  it.each(valid)('%s gives valid DMN', async (file) => {
    const { xml, model, layout, diagnostics } = await compileDmn(read(file));
    expect(diagnostics).toEqual([]);
    expect(checkDrdLayout(model, layout).problems).toEqual([]);
    await expectDmnSchemaValid(xml);
    await expectDmnModdleImport(xml);
    await expectDmnJsImport(xml);
  });

  it('writes colours as the BPMN output does (ADR-011)', async () => {
    const { xml } = await compileDmn(
      read('test/fixtures/dmn/valid/names-and-colours.dmnt'),
    );
    expect(xml).toContain('color:background-color="#BBDEFB"');
    expect(xml).toContain('color:border-color="#831311"');
  });
});

function header(file: string) {
  const lines = read(file).split('\n');
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

describe('DMN corpus', () => {
  it('reads the codes and sections from the notation', () => {
    expect(codes.length).toBeGreaterThan(15);
    expect(sections).toContain('4.3');
  });

  it.each(codes.filter((c) => c !== 'BT540'))(
    '%s has a diagnostics fixture',
    (code) => {
      const files = diagnostics.filter((f) => basename(f).startsWith(code));
      expect(files).not.toHaveLength(0);
      for (const f of files)
        expect(header(f).expects.map((e) => e.code)).toContain(code);
    },
  );

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
      for (const s of covers) expect(sections).toContain(s);
      for (const { line, col } of expects) {
        const text = lines[line - 1];
        expect(text, `line ${line}`).toBeDefined();
        expect(text![col - 1], `${line}:${col}`).not.toBe(' ');
      }
      if (!file.includes('/diagnostics/')) {
        expect(expects).toHaveLength(0);
        expect(covers).not.toHaveLength(0);
      }
    },
  );
});
