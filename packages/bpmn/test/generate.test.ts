import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from '@bpmn-text/core';
import { layout } from '@bpmn-text/layout';
import {
  closeBrowser,
  expectBpmnJsImport,
  expectModdleImport,
  expectSchemaValid,
} from '@bpmn-text/test-utils';
import { afterAll, describe, expect, it } from 'vitest';
import { generate } from '../src/index.js';

afterAll(closeBrowser);

const root = join(import.meta.dirname, '../../..');
const corpus = ['examples', 'test/fixtures/valid'].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.bpmnt'))
    .map((f) => `${dir}/${f}`),
);
const model = (file: string) =>
  check(readFileSync(join(root, file), 'utf8')).model;

describe.each(corpus)('generate: %s', (file) => {
  it('writes valid semantic BPMN', async () => {
    const xml = await generate(model(file));
    expect(xml).not.toContain('bpmndi:');
    await expectSchemaValid(xml);
    await expectModdleImport(xml);
  });

  it('writes diagram interchange that bpmn-js imports cleanly', async () => {
    const m = model(file);
    const xml = await generate(m, await layout(m));
    await expectSchemaValid(xml);
    await expectModdleImport(xml);
    await expectBpmnJsImport(xml);
  });
});

describe('generate', () => {
  it('writes event definitions, boundary events and defaults', async () => {
    const xml = await generate(
      check(`start timer Monday
task Check
  on error Failed -> end error Broken
  on message Ping [non-interrupting] -> end Pinged
xor Ok?
  yes: end Done
  else: end terminate Stopped
`).model,
    );
    expect(xml).toContain(
      '<bpmn:timerEventDefinition id="Event_monday_definition" />',
    );
    expect(xml).toMatch(
      /<bpmn:boundaryEvent id="Event_failed" name="Failed" attachedToRef="Activity_check">/,
    );
    expect(xml).toContain('cancelActivity="false"');
    expect(xml).toMatch(
      /<bpmn:exclusiveGateway id="Gateway_ok" name="Ok\?" default="Flow_ok__stopped">/,
    );
    expect(xml).toContain('<bpmn:terminateEventDefinition');
    await expectSchemaValid(xml);
  });

  it('writes a collaboration with lanes as horizontal shapes', async () => {
    const m = model('examples/04-collaboration.bpmnt');
    const xml = await generate(m, await layout(m));
    expect(xml).toContain(
      '<bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collaboration_1">',
    );
    expect(xml).toContain(
      '<bpmndi:BPMNShape id="Lane_sales_di" bpmnElement="Lane_sales" isHorizontal="true">',
    );
    expect(xml).toContain(
      '<bpmndi:BPMNEdge id="MessageFlow_bank__payment_received_di"',
    );
  });
});
