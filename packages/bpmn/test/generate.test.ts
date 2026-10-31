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

  it('writes markers and call activities (#36)', async () => {
    const xml = await generate(
      check(`start
task A [loop]
user B [parallel]
service C [sequential]
call D
end
`).model,
    );
    expect(xml).toMatch(
      /<bpmn:task id="Activity_a" name="A">[^]*<bpmn:standardLoopCharacteristics \/>/,
    );
    expect(xml).toMatch(
      /<bpmn:userTask id="Activity_b" name="B">[^]*<bpmn:multiInstanceLoopCharacteristics \/>/,
    );
    expect(xml).toContain(
      '<bpmn:multiInstanceLoopCharacteristics isSequential="true" />',
    );
    expect(xml).toContain('<bpmn:callActivity id="Activity_d" name="D">');
    await expectSchemaValid(xml);
  });

  it('writes documentation (#63)', async () => {
    const xml = await generate(
      model('test/fixtures/valid/documentation.bpmnt'),
    );
    expect(xml).toContain(
      '<bpmn:documentation>Handles refunds for orders returned within 30 days.</bpmn:documentation>',
    );
    expect(xml).toContain(
      '<bpmn:documentation>Staff at the warehouse returns counter.</bpmn:documentation>',
    );
    expect(xml).toContain(
      'Checks each line against the catalogue -&gt; unknown items are rejected (see #refund-rules).\nA second doc line',
    );
  });

  it('writes data objects, stores and associations (#34)', async () => {
    const xml = await generate(model('examples/06-subprocess-data.bpmnt'));
    expect(xml).toContain(
      '<bpmn:dataStore id="DataStore_accounting_db" name="Accounting DB" />',
    );
    expect(xml).toContain(
      '<bpmn:dataStoreReference id="DataStoreReference_accounting_db" name="Accounting DB" dataStoreRef="DataStore_accounting_db" />',
    );
    expect(xml).toContain(
      '<bpmn:dataObjectReference id="DataObjectReference_invoice" name="Invoice" dataObjectRef="DataObject_invoice" />',
    );
    expect(xml).toMatch(
      /<bpmn:dataInputAssociation id="DataInputAssociation_collect_billable_hours__accounting_db">\s*<bpmn:sourceRef>DataStoreReference_accounting_db<\/bpmn:sourceRef>\s*<bpmn:targetRef>Activity_collect_billable_hours_property<\/bpmn:targetRef>/,
    );
    expect(xml).toMatch(
      /<bpmn:dataOutputAssociation id="DataOutputAssociation_generate_pdf__invoice">\s*<bpmn:targetRef>DataObjectReference_invoice<\/bpmn:targetRef>/,
    );
  });

  it('writes text annotations with associations (#35)', async () => {
    const xml = await generate(model('examples/06-subprocess-data.bpmnt'));
    expect(xml).toMatch(
      /<bpmn:textAnnotation id="TextAnnotation_collect_billable_hours">\s*<bpmn:text>Includes contractors from the timesheet export<\/bpmn:text>/,
    );
    expect(xml).toContain(
      '<bpmn:association id="Association_collect_billable_hours" sourceRef="Activity_collect_billable_hours" targetRef="TextAnnotation_collect_billable_hours" />',
    );
  });

  it('writes groups with category values in the collaboration (#59)', async () => {
    const xml = await generate(model('test/fixtures/valid/groups.bpmnt'));
    expect(xml).toMatch(
      /<bpmn:category id="Category_groups">\s*<bpmn:categoryValue id="CategoryValue_ordering" value="Ordering" \/>/,
    );
    expect(xml).toMatch(
      /<bpmn:collaboration id="Collaboration_1">[^]*<bpmn:group id="Group_delivery" categoryValueRef="CategoryValue_delivery" \/>[^]*<\/bpmn:collaboration>/,
    );
  });

  it('writes colours in both namespaces (#61)', async () => {
    const m = model('test/fixtures/valid/colours.bpmnt');
    const xml = await generate(m, await layout(m));
    expect(xml).toContain(
      'xmlns:bioc="http://bpmn.io/schema/bpmn/biocolor/1.0"',
    );
    expect(xml).toContain(
      'xmlns:color="http://www.omg.org/spec/BPMN/non-normative/color/1.0"',
    );
    expect(xml).toMatch(
      /<bpmndi:BPMNShape id="Activity_escalate_di" bpmnElement="Activity_escalate" bioc:stroke="#831311" bioc:fill="#FFE0E0" color:background-color="#FFE0E0" color:border-color="#831311">/,
    );
    // Edges take the stroke of their source; labels its text colour.
    expect(xml).toMatch(
      /<bpmndi:BPMNEdge id="Flow_escalate__invoice_di" bpmnElement="Flow_escalate__invoice" bioc:stroke="#831311" color:border-color="#831311">/,
    );
    expect(xml).toMatch(
      /bpmnElement="Event_order_received" bioc:stroke="#0D4372" color:border-color="#0D4372">[^]*?<bpmndi:BPMNLabel color:color="#0D4372">/,
    );
  });
});
