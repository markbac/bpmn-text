// Renders the pictures in docs/images (#47, #65, #81): every example, every
// ```bpmnt and ```dmnt block in docs/*.md after a `<!-- screenshot: name -->`
// line, and the web editor itself. A DMN picture is its DRD, with one more
// picture per decision table. Needs a build (`npm run build`) and Chromium.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = 'packages/cli/dist/cli.js';
const out = 'docs/images/';

const snippets = mkdtempSync(join(tmpdir(), 'bpmn-text-screenshots-'));
for (const file of readdirSync('docs').filter((f) => f.endsWith('.md'))) {
  const text = readFileSync(join('docs', file), 'utf8');
  const pattern =
    /<!-- screenshot: ([\w-]+) -->\s*```(bpmnt|dmnt)\n([^]*?)```/g;
  for (const [, name, language, source] of text.matchAll(pattern)) {
    writeFileSync(join(snippets, `${name}.${language}`), source);
  }
}

// Globs use forward slashes, on Windows too.
const allSnippets = join(snippets, '*.{bpmnt,dmnt}').replaceAll('\\', '/');
for (const inputs of ['examples/*.bpmnt', 'examples/dmn/*.dmnt', allSnippets]) {
  const result = spawnSync(
    'node',
    [cli, 'build', inputs, '-f', 'png', '-o', out],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The key to an example, as shown in the notation reference.
const key = spawnSync(
  'node',
  [
    cli,
    'legend',
    'examples/08-broadband-provisioning.bpmnt',
    '-f',
    'png',
    '-o',
    out,
  ],
  { stdio: 'inherit' },
);
if (key.status !== 0) process.exit(key.status ?? 1);

// The web editor, as built, with example 07 open.
const { preview } = await import('vite');
const { chromium } = await import('playwright-core');
const server = await preview({
  root: 'apps/editor',
  logLevel: 'error',
  preview: { port: 0, host: '127.0.0.1' },
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 800 },
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.selectOption('#examples', 'bpmn:07-multi-phase');
  await page.waitForSelector('[data-element-id="Group_after_sales"]');
  await page.click('[data-element-id="Activity_publish_plan"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'editor.png') });

  // The editor with a DMN example, the cursor in a table.
  await page.selectOption('#examples', 'dmn:02-dinner');
  await page.waitForSelector('#dmn .djs-element');
  await page.evaluate(() => {
    // In the page, where the editor puts itself on `window` for tests.
    const { view } = globalThis.bpmnTextEditor;
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.line(15).from + 8 } });
  });
  await page.waitForSelector('#dmn .tjs-table');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'editor-dmn.png') });
} finally {
  await browser.close();
  await server.close();
}
