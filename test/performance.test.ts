import { check } from '@bpmn-text/core';
import { compile } from 'bpmn-text';
import { describe, expect, it } from 'vitest';
import { sizes, synthetic } from './bench/synthetic.js';

const nodeCount = (source: string) =>
  check(source).model.pools.reduce(
    (n, p) => n + (p.process?.nodes.length ?? 0),
    0,
  );

describe('performance (#50)', () => {
  it.each(sizes)(
    'generates a valid diagram of $nodes nodes, $pools pools, $lanes lanes',
    ({ nodes, pools, lanes }) => {
      const source = synthetic({ nodes, pools, lanes });
      const { model, diagnostics } = check(source);
      expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
      expect(model.pools.filter((p) => p.process)).toHaveLength(pools);
      expect(nodeCount(source)).toBeGreaterThanOrEqual(nodes * 0.9);
      expect(nodeCount(source)).toBeLessThanOrEqual(nodes * 1.1);
    },
  );

  it('compiles a 200-node collaboration in under 1 s (FR-28)', async () => {
    const source = synthetic({ nodes: 200, pools: 4, lanes: 3 });
    await compile(source); // warm up
    // The best of three, so that tests running alongside do not decide it.
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      await compile(source);
      times.push(performance.now() - start);
    }
    expect(Math.min(...times)).toBeLessThan(1000);
  }, 30_000);
});
