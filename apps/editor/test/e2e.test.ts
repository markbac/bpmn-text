import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { build, preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Smoke test of the built editor in headless Chromium (#37-#41): the
// production bundle, served statically as it would be deployed (#42).
const root = join(import.meta.dirname, '..');
const outDir = mkdtempSync(join(tmpdir(), 'bpmn-text-editor-'));
let server: PreviewServer;
let browser: Browser;
let url: string;

beforeAll(async () => {
  await build({
    root,
    logLevel: 'error',
    build: { outDir, emptyOutDir: true },
  });
  server = await preview({
    root,
    logLevel: 'error',
    build: { outDir },
    preview: { port: 0, host: '127.0.0.1' },
  });
  url = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(outDir, { recursive: true, force: true });
});

/** A fresh page, with no saved document. */
async function open(path = ''): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url + path);
  await page.waitForSelector('.djs-element[data-element-id]');
  return page;
}

const shapes = (page: Page) =>
  page.$$eval('.djs-element[data-element-id]', (els) =>
    els.map((e) => e.getAttribute('data-element-id')),
  );
const source = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        bpmnTextEditor: { view: { state: { doc: { toString(): string } } } };
      }
    ).bpmnTextEditor.view.state.doc.toString(),
  );

/** Replaces the whole document, as if typed. */
async function type(page: Page, text: string) {
  await page.click('.cm-content');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

const status = (page: Page) => page.textContent('#status');

describe('web editor', { timeout: 30_000 }, () => {
  it('opens example 04 with its diagram (#37)', async () => {
    const page = await open();
    expect(await source(page)).toBe(
      readFileSync(join(root, '../../examples/04-collaboration.bpmnt'), 'utf8'),
    );
    expect(await shapes(page)).toContain('Participant_bank');
    // Keywords are highlighted (#39).
    const pool = await page.$$eval('.cm-line span', (spans) =>
      spans.some(
        (s) =>
          s.textContent === 'pool' && getComputedStyle(s).fontWeight === '600',
      ),
    );
    expect(pool).toBe(true);
    await page.screenshot({ path: join(outDir, '..', 'bpmn-text-editor.png') });
  });

  it('recompiles as you type and keeps the last diagram on errors (#38)', async () => {
    const page = await open();
    await type(page, 'start Begin\ntask Write tests\nend Done\n');
    await page.waitForSelector('[data-element-id="Activity_write_tests"]');
    await type(page, 'start Begin\ntask Write tests -> Nowhere\n');
    await page.waitForFunction(() =>
      document.querySelector('#status')?.textContent?.includes('1 error'),
    );
    expect(await page.$('.cm-lintRange-error')).not.toBeNull();
    expect(await shapes(page)).toContain('Activity_write_tests');
    expect(await status(page)).toContain('showing the last diagram');
  });

  it('completes element names after an arrow (#39)', async () => {
    const page = await open();
    await type(page, 'start\ntask Check order\ntask Fix order\n');
    await page.waitForSelector('[data-element-id="Activity_fix_order"]');
    await page.keyboard.insertText('-> ');
    await page.keyboard.press('Control+Space');
    await page.waitForSelector('.cm-tooltip-autocomplete');
    const options = await page.$$eval('.cm-tooltip-autocomplete li', (items) =>
      items.map((i) => i.textContent),
    );
    expect(options).toContain('Check order');
  });

  it('syncs the cursor and the diagram both ways (#40)', async () => {
    const page = await open();
    await page.click('.cm-content');
    // Put the cursor on "receive Receive order" (line 13 of example 04).
    await page.evaluate(() => {
      const { view } = (
        window as unknown as {
          bpmnTextEditor: {
            view: {
              state: { doc: { line(n: number): { from: number } } };
              dispatch(spec: object): void;
            };
          };
        }
      ).bpmnTextEditor;
      view.dispatch({
        selection: { anchor: view.state.doc.line(13).from + 4 },
      });
    });
    await page.waitForSelector(
      '.source-selected[data-element-id="Activity_receive_order"]',
    );
    await page.click('[data-element-id="Activity_check_credit"]');
    const selected = await page.evaluate(() => getSelection()?.toString());
    expect(selected ?? '').toContain('Check credit');
  });

  it('reopens a share link exactly in a fresh browser (#41)', async () => {
    const page = await open();
    const text = 'title "Shared"\nstart\nuser Approve # comment\nend\n';
    await type(page, text);
    await page.waitForSelector('[data-element-id="Activity_approve"]');
    await page.click('#share');
    const hash = await page.evaluate(() => location.hash);
    const fresh = await open(`/${hash}`);
    expect(await source(fresh)).toBe(text);
  });

  it('downloads source, BPMN, SVG and PNG (#41)', async () => {
    const page = await open();
    const names: string[] = [];
    for (const format of [
      'source',
      'xml',
      'svg',
      'png',
      'key-svg',
      'key-png',
    ]) {
      await page.click('#download');
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click(`[data-format="${format}"]:not([hidden])`),
      ]);
      names.push(download.suggestedFilename());
      if (format === 'key-svg') {
        const key = readFileSync(await download.path(), 'utf8');
        expect(key).toContain('Start event');
        // Symbols that bpmn-js drew, off screen.
        expect(key).toContain('djs-group');
      }
    }
    expect(names).toEqual([
      'order-fulfilment.bpmnt',
      'order-fulfilment.bpmn',
      'order-fulfilment.svg',
      'order-fulfilment.png',
      'order-fulfilment.legend.svg',
      'order-fulfilment.legend.png',
    ]);
  });

  it('edits DMN: a rule, an overlap, and the table preview (#79)', async () => {
    const page = await open();
    await page.selectOption('#examples', 'dmn:01-loan-approval');
    await page.waitForSelector(
      '#dmn .djs-element[data-element-id="Decision_approve_loan"]',
    );
    expect(await page.isHidden('#diagram')).toBe(true);
    // Into the table: the preview shows it.
    await page.evaluate(() => {
      const { view } = (
        window as unknown as {
          bpmnTextEditor: {
            view: {
              state: { doc: { line(n: number): { from: number; to: number } } };
              dispatch(spec: object): void;
            };
          };
        }
      ).bpmnTextEditor;
      const end = view.state.doc.line(16).to;
      view.dispatch({
        selection: { anchor: end },
        changes: {
          from: end,
          insert: '\n    | >= 650 | - | false | "Overlaps" | |',
        },
      });
    });
    await page.waitForFunction(() =>
      /^[1-9]d* errors?/.test(
        document.querySelector('#status')?.textContent ?? '',
      ),
    );
    expect(await page.$('.cm-lintRange-error')).not.toBeNull();
    const lint = await page.evaluate(
      () => [...document.querySelectorAll('.cm-lintRange-error')].length,
    );
    expect(lint).toBeGreaterThan(0);
    // The last good table stays while there are errors; under `first`,
    // overlaps are allowed, and the table shows the new rule.
    await page.waitForSelector('#dmn .tjs-table');
    await page.evaluate(() => {
      const { view } = (
        window as unknown as {
          bpmnTextEditor: {
            view: {
              state: { doc: { toString(): string; length: number } };
              dispatch(spec: object): void;
            };
          };
        }
      ).bpmnTextEditor;
      const text = view.state.doc
        .toString()
        .replace('[hit: unique]', '[hit: first]');
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.indexOf('"Overlaps"') },
      });
    });
    await page.waitForFunction(
      () => document.querySelectorAll('#dmn .tjs-table tbody tr').length === 4,
    );
    expect(await page.textContent('#dmn .tjs-table')).toContain('Overlaps');
    // Back in the DRD when the cursor leaves the decision.
    await page.evaluate(() => {
      const { view } = (
        window as unknown as {
          bpmnTextEditor: { view: { dispatch(spec: object): void } };
        }
      ).bpmnTextEditor;
      view.dispatch({ selection: { anchor: 0 } });
    });
    await page.waitForSelector(
      '#dmn .djs-element[data-element-id="InputData_credit_score"]',
    );
    // Downloads are DMN ones.
    await page.click('#download');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('[data-format="xml"]:not([hidden])'),
    ]);
    expect(download.suggestedFilename()).toBe('loan-approval.dmn');
    // A share link keeps the notation.
    await page.click('#share');
    const hash = await page.evaluate(() => location.hash);
    expect(hash.startsWith('#dmn=')).toBe(true);
    const fresh = await open(`/${hash}`);
    expect(await fresh.inputValue('#language')).toBe('dmn');
  });

  it('moves between table cells with Tab', async () => {
    const page = await open();
    await page.selectOption('#examples', 'dmn:01-loan-approval');
    await page.waitForSelector('#dmn .djs-element');
    await page.evaluate(() => {
      const { view } = (
        window as unknown as {
          bpmnTextEditor: {
            view: {
              state: { doc: { line(n: number): { from: number } } };
              dispatch(spec: object): void;
              focus(): void;
            };
          };
        }
      ).bpmnTextEditor;
      view.focus();
      view.dispatch({
        selection: { anchor: view.state.doc.line(14).from + 6 },
      });
    });
    await page.keyboard.press('Tab');
    const selected = await page.evaluate(() => getSelection()?.toString());
    expect(selected).toBe('<= 50000');
  });
});
