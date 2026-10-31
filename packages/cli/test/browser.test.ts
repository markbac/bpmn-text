import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { labelSize } from '@bpmn-text/layout';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { compile } from '../src/index.js';

const source = readFileSync(
  join(import.meta.dirname, '../../../examples/04-collaboration.bpmnt'),
  'utf8',
);
const labels = ['Approved?', 'Last working day of month', 'Größe prüfen'];

it('compiles in a browser bundle, with the same output as in Node', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { compile } from 'bpmn-text';
        import { labelSize } from '@bpmn-text/layout';
        window.run = async (source, labels) => ({
          xml: (await compile(source)).xml,
          sizes: labels.map((l) => labelSize(l)),
        });
      `,
      resolveDir: join(import.meta.dirname, '..'),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    conditions: ['source'],
    write: false,
    logLevel: 'silent',
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const result = await page.evaluate(
      ([source, labels]) =>
        (
          globalThis as unknown as {
            run(
              s: string,
              l: string[],
            ): Promise<{ xml: string; sizes: unknown }>;
          }
        ).run(source, labels),
      [source, labels] as const,
    );
    expect(result.xml).toBe((await compile(source)).xml);
    expect(result.sizes).toEqual(labels.map((l) => labelSize(l)));
  } finally {
    await browser.close();
  }
}, 30_000);
