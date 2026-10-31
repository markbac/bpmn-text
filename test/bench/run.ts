// Benchmarks the compiler's phases on synthetic diagrams (#50), after
// `npm run build`: `npm run bench`. Prints the median time of each phase
// and warns (as a GitHub annotation in CI) when one is more than 20%
// slower than test/bench/baseline.json. `npm run bench -- --update`
// stores the results as the new baseline.
import { generate } from '@bpmn-text/bpmn';
import { check, parse } from '@bpmn-text/core';
import { layout } from '@bpmn-text/layout';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { sizes, synthetic } from './synthetic.ts';

const RUNS = 7;
const TOLERANCE = 0.2;
const baselineFile = new URL('baseline.json', import.meta.url);

type Phases = Record<'parse' | 'check' | 'layout' | 'generate', number>;

async function time(fn: () => unknown): Promise<number> {
  await fn(); // warm up
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(RUNS / 2)]! * 10) / 10;
}

const results: Record<string, Phases> = {};
for (const size of sizes) {
  const name = `${size.nodes} nodes, ${size.pools} pools, ${size.lanes} lanes`;
  const source = synthetic(size);
  const { model } = check(source);
  const laid = await layout(model);
  results[name] = {
    parse: await time(() => parse(source)),
    check: await time(() => check(source)),
    layout: await time(() => layout(model)),
    generate: await time(() => generate(model, laid)),
  };
}

const baseline: Record<string, Phases> = existsSync(baselineFile)
  ? JSON.parse(readFileSync(baselineFile, 'utf8'))
  : {};
const rows = Object.entries(results).map(([name, phases]) => ({
  diagram: name,
  ...phases,
  total: Math.round(Object.values(phases).reduce((a, b) => a + b, 0) * 10) / 10,
}));
console.log('Median milliseconds per phase (check includes parse):');
console.table(rows);

let regressions = 0;
for (const [name, phases] of Object.entries(results)) {
  for (const [phase, ms] of Object.entries(phases)) {
    const before = baseline[name]?.[phase as keyof Phases];
    // Below a millisecond, the noise is larger than any regression.
    if (before === undefined || ms < 1 || ms <= before * (1 + TOLERANCE))
      continue;
    regressions++;
    const message = `${phase} of ${name}: ${ms} ms, baseline ${before} ms (+${Math.round((ms / before - 1) * 100)}%)`;
    console.log(
      process.env.GITHUB_ACTIONS
        ? `::warning title=Benchmark regression::${message}`
        : `Slower than the baseline: ${message}`,
    );
  }
}
if (!regressions)
  console.log('No phase is more than 20% slower than the baseline.');
if (process.argv.includes('--update')) {
  writeFileSync(baselineFile, `${JSON.stringify(results, null, 2)}\n`);
  console.log('Stored as the new baseline.');
}
