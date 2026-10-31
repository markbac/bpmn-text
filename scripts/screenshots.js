// Renders the pictures in docs/images (#47, #65): every example, every
// ```bpmnt block in docs/*.md after a `<!-- screenshot: name -->` line, and
// the web editor itself. Needs a build (`npm run build`) and Chromium.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = 'packages/cli/dist/cli.js';
const out = 'docs/images/';

const snippets = mkdtempSync(join(tmpdir(), 'bpmn-text-screenshots-'));
for (const file of readdirSync('docs').filter((f) => f.endsWith('.md'))) {
  const text = readFileSync(join('docs', file), 'utf8');
  const pattern = /<!-- screenshot: ([\w-]+) -->\s*```bpmnt\n([^]*?)```/g;
  for (const [, name, source] of text.matchAll(pattern)) {
    writeFileSync(join(snippets, `${name}.bpmnt`), source);
  }
}

for (const inputs of ['examples/*.bpmnt', join(snippets, '*.bpmnt')]) {
  const result = spawnSync(
    'node',
    [cli, 'build', inputs, '-f', 'png', '-o', out],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

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
  await page.selectOption('#examples', '07-multi-phase');
  await page.waitForSelector('[data-element-id="Group_after_sales"]');
  await page.click('[data-element-id="Activity_publish_plan"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'editor.png') });
} finally {
  await browser.close();
  await server.close();
}
