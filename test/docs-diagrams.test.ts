import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Every ```mermaid block in the README and docs/ must parse, or GitHub
// shows an error instead of the diagram.
const root = join(import.meta.dirname, '..');
const mermaid = createRequire(import.meta.url).resolve(
  'mermaid/dist/mermaid.min.js',
);
const files = [
  'README.md',
  ...readdirSync(join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];
const blocks = files.flatMap((file) => {
  const text = readFileSync(join(root, file), 'utf8');
  return [...text.matchAll(/```mermaid\n([^]*?)```/g)].map((m) => {
    const line = text.slice(0, m.index).split('\n').length;
    return [`${file}:${line}`, m[1]!] as const;
  });
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => browser?.close());

describe('documentation diagrams', () => {
  it('finds the diagrams', () => {
    expect(blocks.length).toBeGreaterThan(10);
  });

  it('parses every Mermaid diagram', async () => {
    const page = await browser.newPage();
    await page.addScriptTag({ path: mermaid });
    const errors: string[] = [];
    for (const [where, source] of blocks) {
      const error = await page.evaluate(async (s) => {
        try {
          await (
            globalThis as unknown as {
              mermaid: { parse(s: string): Promise<unknown> };
            }
          ).mermaid.parse(s);
          return undefined;
        } catch (e) {
          return String((e as Error).message ?? e).split('\n')[0];
        }
      }, source);
      if (error) errors.push(`${where}: ${error}`);
    }
    await page.close();
    expect(errors).toEqual([]);
  }, 30_000);
});
