import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeBrowser,
  expectBpmnJsImport,
  expectModdleImport,
  expectSchemaValid,
} from '../src/index.js';

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}.bpmn`, import.meta.url), 'utf8');

afterAll(closeBrowser);

describe('expectSchemaValid', () => {
  it('accepts a valid diagram, including colour extensions', async () => {
    await expectSchemaValid(fixture('good'));
  });

  it('reports schema errors with line numbers', async () => {
    await expect(expectSchemaValid(fixture('bad-schema'))).rejects.toThrow(
      /not valid against the BPMN 2\.0 schema:\n {2}- line 22: .*'targetRef' is required but missing/,
    );
  });
});

describe('expectModdleImport', () => {
  it('accepts a valid diagram', async () => {
    await expectModdleImport(fixture('good'));
  });

  it('reports bpmn-moddle warnings', async () => {
    await expect(expectModdleImport(fixture('bad-moddle'))).rejects.toThrow(
      /bpmn-moddle reported warnings:\n {2}- unparsable content <bpmn:taks> detected\n {4}line: 17/,
    );
  });
});

describe('expectBpmnJsImport', () => {
  it('accepts a valid diagram', async () => {
    await expectBpmnJsImport(fixture('good'));
  });

  it('reports bpmn-js import warnings that the other checks miss', async () => {
    const xml = fixture('bad-bpmnjs');
    await expectSchemaValid(xml);
    await expectModdleImport(xml);
    await expect(expectBpmnJsImport(xml)).rejects.toThrow(
      /bpmn-js could not import the BPMN XML cleanly:\n {2}- warning: multiple DI elements defined for <bpmn:EndEvent id="Event_done" \/>/,
    );
  });
});
