import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkLayout, type LayoutReport } from '@bpmn-text/layout';
import { compile } from 'bpmn-text';
import { describe, expect, it } from 'vitest';

// Layout quality baselines (#23): the invariants must hold, and the metrics
// may not get worse than the stored baseline. Run
// `npm run test:update-baselines` to store new ones on purpose.
const root = join(import.meta.dirname, '..');
const update = process.env.UPDATE_LAYOUT_BASELINES === '1';
/** Relative slack for the continuous metrics. */
const tolerance = 0.05;
const examples = readdirSync(join(root, 'examples'))
  .filter((f) => f.endsWith('.bpmnt'))
  .map((f) => f.replace(/\.bpmnt$/, ''));

type Metrics = Omit<LayoutReport, 'problems'>;

describe.each(examples)('layout baseline: %s', (name) => {
  it('meets the invariants and its baseline', async () => {
    const { model, layout } = await compile(
      readFileSync(join(root, `examples/${name}.bpmnt`), 'utf8'),
    );
    const { problems, ...metrics } = checkLayout(model, layout);
    expect(problems).toEqual([]);

    const file = join(root, `test/fixtures/layout/${name}.json`);
    if (update || !existsSync(file)) {
      writeFileSync(file, `${JSON.stringify(metrics, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(readFileSync(file, 'utf8')) as Metrics;
    const worse = (Object.keys(baseline) as (keyof Metrics)[]).filter((k) => {
      const exact = k !== 'edgeLength' && k !== 'area';
      return metrics[k] > baseline[k] * (exact ? 1 : 1 + tolerance);
    });
    expect(
      Object.fromEntries(worse.map((k) => [k, metrics[k]])),
      `worse than test/fixtures/layout/${name}.json`,
    ).toEqual(Object.fromEntries(worse.map((k) => [k, baseline[k]])));
  });
});
