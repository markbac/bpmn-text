// Stores the current layout metrics as the new baselines in
// test/fixtures/layout/ (issue #23). Review the diff before committing.
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'npx',
  ['vitest', 'run', 'test/layout-baselines.test.ts'],
  {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, UPDATE_LAYOUT_BASELINES: '1' },
  },
);
process.exit(result.status ?? 1);
