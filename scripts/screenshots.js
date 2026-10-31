// Renders every example to docs/images/<name>.png for the documentation
// (#47, #65). Needs a build (`npm run build`) and Chromium for the renderer.
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'node',
  [
    'packages/cli/dist/cli.js',
    'build',
    'examples/*.bpmnt',
    '-f',
    'png',
    '-o',
    'docs/images/',
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
