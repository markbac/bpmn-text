import {
  closeBrowser,
  expectBpmnJsImport,
  expectModdleImport,
  expectSchemaValid,
} from '@bpmn-text/test-utils';
import { afterAll, describe, expect, it } from 'vitest';
import { toXml } from '../spike/bpmn.ts';
import { collaboration, gateways, lanes } from '../spike/ir.ts';
import { layout } from '../spike/layout.ts';
import { measure } from '../spike/metrics.ts';

afterAll(closeBrowser);

describe.each([
  ['02-gateways', gateways],
  ['03-lanes', lanes],
  ['04-collaboration', collaboration],
])('layout spike: %s', (_, model) => {
  it('meets the layout invariants', async () => {
    const m = measure(model, await layout(model));
    expect(m).toMatchObject({
      overlaps: 0,
      outsideBand: 0,
      storyInversions: 0,
      loopsDrawnBack: m.loops,
      messageInversions: 0,
      edgeThroughShape: 0,
    });
  });

  it('is deterministic', async () => {
    const a = toXml(model, await layout(model));
    expect(toXml(model, await layout(model))).toBe(a);
  });

  it('produces BPMN that validates and imports cleanly', async () => {
    const xml = toXml(model, await layout(model));
    await expectSchemaValid(xml);
    await expectModdleImport(xml);
    await expectBpmnJsImport(xml);
  });
});
