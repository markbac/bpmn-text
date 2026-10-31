// Renders the pictures in docs/images (#47, #65): every example, and every
// ```bpmnt block in docs/*.md after a `<!-- screenshot: name -->` line.
// Needs a build (`npm run build`) and Chromium for the renderer.
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
