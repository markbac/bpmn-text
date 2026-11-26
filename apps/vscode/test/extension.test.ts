import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { vocabulary } from '@bpmn-text/core';
import { dmnVocabulary } from '@bpmn-text/dmn';
import { compile } from '../src/compile.js';

const read = (file: string) =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')) as {
    contributes: {
      grammars: { path: string }[];
      languages: { configuration: string }[];
      commands: { command: string }[];
      menus: Record<string, { command: string }[]>;
    };
    repository: Record<string, { match?: string }>;
  };

const manifest = read('package.json');
const grammar = read('syntaxes/bpmnt.tmLanguage.json');

const words = (pattern: string | undefined) =>
  new Set(/\(((?:[\w-]+\|)+[\w-]+)\)/.exec(pattern ?? '')?.[1]?.split('|'));

describe('the grammar (FR-50)', () => {
  it('knows every keyword of the notation', () => {
    const known = words(grammar.repository.keyword?.match);
    for (const k of vocabulary.keywords) expect(known, k).toContain(k);
  });

  it('knows every event type', () => {
    const known = words(grammar.repository.event?.match?.split('\\s+')[1]);
    const types = new Set(Object.values(vocabulary.eventTypes).flat());
    for (const t of types) expect(known, t).toContain(t);
  });

  it('knows every attribute', () => {
    const attributes = grammar.repository.attributes as unknown as {
      patterns: { match?: string }[];
    };
    const known = words(attributes.patterns[0]?.match);
    for (const a of vocabulary.attributes) expect(known, a).toContain(a);
  });
});

describe('the manifest', () => {
  it('points at files that exist', () => {
    const files = [
      ...manifest.contributes.grammars.map((g) => g.path),
      ...manifest.contributes.languages.map((l) => l.configuration),
    ];
    for (const file of files) {
      expect(existsSync(new URL(`../${file}`, import.meta.url)), file).toBe(
        true,
      );
    }
  });

  it('only offers commands it declares', () => {
    const declared = manifest.contributes.commands.map((c) => c.command);
    for (const items of Object.values(manifest.contributes.menus)) {
      for (const item of items) expect(declared).toContain(item.command);
    }
  });
});

describe('compile', () => {
  it('compiles a document for the preview', async () => {
    const result = await compile('start\ntask Check\nend\n');
    expect(result.errors).toBe(0);
    expect(result.xml).toContain('<bpmn:task');
    expect(Object.keys(result.sourceMap).length).toBeGreaterThan(0);
  });

  it('counts errors and still draws', async () => {
    const result = await compile('start\ntask A\n-> Nowhere\n');
    expect(result.errors).toBeGreaterThan(0);
    expect(result.xml).toContain('<bpmn:task');
  });

  it('skips the layout of text with errors when asked', async () => {
    const result = await compile('start\ntask A\n-> Nowhere\n', {
      draw: 'without-errors',
    });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.xml).toBeUndefined();
    expect(Object.keys(result.sourceMap).length).toBeGreaterThan(0);
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
    await compile(source); // warm up
    // The best of five, so that other tests running at the same time do
    // not decide the result.
    const times = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      expect((await compile(source)).errors).toBe(0);
      times.push(performance.now() - started);
    }
    // As in the editor: CI checks 200 ms in a step without coverage.
    const limit = process.env.BPMN_TEXT_COVERAGE ? 1000 : 200;
    expect(Math.min(...times)).toBeLessThan(limit);
  });
});

describe('DMN (#82)', () => {
  const dmnGrammar = read('syntaxes/dmnt.tmLanguage.json');

  it('declares the dmnt language with its own grammar', () => {
    const languages = manifest.contributes.languages as unknown as {
      id: string;
      extensions: string[];
    }[];
    expect(languages.find((l) => l.id === 'dmnt')?.extensions).toEqual([
      '.dmnt',
    ]);
    expect(manifest.contributes.grammars.map((g) => g.path)).toContain(
      './syntaxes/dmnt.tmLanguage.json',
    );
  });

  it('highlights every DMN keyword and attribute', () => {
    const keywords = words(dmnGrammar.repository.keyword?.match);
    for (const k of dmnVocabulary.keywords) expect(keywords, k).toContain(k);
    const attributes = dmnGrammar.repository.attributes as unknown as {
      patterns: { match?: string }[];
    };
    const known = words(attributes.patterns[0]?.match);
    for (const a of dmnVocabulary.attributes) expect(known, a).toContain(a);
  });

  it('compiles DMN for the preview, with the decisions to open', async () => {
    const result = await compile(
      'input A [type: number]\ndecision B [requires: A]\n  table\n    | A | -> B |\n    | > 1 | 1 |\n    | <= 1 | 2 |\n',
      { language: 'dmn' },
    );
    expect(result.errors).toBe(0);
    expect(result.xml).toContain('<dmn:decisionTable');
    expect(result.decisions?.map((d) => d.id)).toEqual(['Decision_b']);
    expect(result.sourceMap.Rule_b_1).toBeDefined();
  });
});
