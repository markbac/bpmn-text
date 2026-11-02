import { expectSchemaValid } from '@bpmn-text/test-utils';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.js';

describe('compile: the extension hook', () => {
  it('turns unknown attributes into vendor extension elements', async () => {
    const { xml } = await compile(
      'start\nservice Charge [job: charge-card]\nend\n',
      {
        extend(node, element, factory) {
          if (!('extra' in node) || !node.extra.job) return;
          element.extensionElements = factory.create('bpmn:ExtensionElements', {
            values: [
              factory.createAny('acme:job', 'http://acme.example/bpmn', {
                type: node.extra.job,
              }),
            ],
          });
        },
      },
    );
    expect(xml).toContain('xmlns:acme="http://acme.example/bpmn"');
    expect(xml).toContain('<acme:job type="charge-card" />');
    await expectSchemaValid(xml);
  });

  it('visits nested nodes, pools, lanes and groups', async () => {
    const seen: string[] = [];
    await compile(
      `pool Shop
  lane Sales
  group Phase
    start
    sub Work
      start
      end
    end
`,
      {
        extend(node) {
          seen.push(node.id);
        },
      },
    );
    expect(seen).toEqual(
      expect.arrayContaining([
        'Participant_shop',
        'Lane_sales',
        'Group_phase',
        'Activity_work',
        'Event_work_start_1',
      ]),
    );
  });
});

describe('compile', () => {
  it('returns XML, the model, the layout and a source map', async () => {
    const result = await compile('start Begin\ntask Work\nend Done\n');
    expect(result.diagnostics).toEqual([]);
    expect(result.xml).toContain('<bpmn:task id="Activity_work" name="Work">');
    expect(result.layout.shapes.has('Activity_work')).toBe(true);
    expect(result.sourceMap.Activity_work?.start).toMatchObject({
      line: 2,
      col: 1,
    });
    // Every BPMN element with an IR ID is in the source map.
    for (const [, id] of result.xml.matchAll(/ id="([^"]+)"/g)) {
      if (
        /^(Definitions|Collaboration|LaneSet|BPMN)|_di$|_definition$/.test(id!)
      )
        continue;
      expect(result.sourceMap, id).toHaveProperty([id!]);
    }
  });

  it('maps every drawn element of example 06 and 07 to its source (#40)', async () => {
    const { readFileSync } = await import('node:fs');
    for (const name of ['06-subprocess-data', '07-multi-phase']) {
      const source = readFileSync(
        new URL(`../../../examples/${name}.bpmnt`, import.meta.url),
        'utf8',
      );
      const result = await compile(source);
      for (const id of [
        ...result.layout.shapes.keys(),
        ...result.layout.edges.keys(),
      ])
        expect(result.sourceMap, id).toHaveProperty([id]);
    }
  });

  it('maps an inserted join to the gateway that caused it (#40)', async () => {
    const { sourceMap } = await compile(
      'start\nand Split\n  - task A\n  - task B\nend\n',
    );
    expect(sourceMap.Gateway_join_after_end_1?.start.line).toBe(2);
  });

  it('reports errors and still returns a diagram', async () => {
    const { diagnostics, xml } = await compile('start\ntask A -> Nowhere\n');
    expect(diagnostics.map((d) => d.code)).toContain('BT202');
    expect(xml).toContain('<bpmndi:BPMNDiagram');
  });

  it('passes the xor-join and layout options through', async () => {
    const source = 'start\nxor Ok?\n  yes: task A\n  no: task B\nend\n';
    const joined = await compile(source);
    const direct = await compile(source, { xorJoin: 'direct' });
    expect(joined.model.pools[0]!.process!.nodes.some((n) => n.generated)).toBe(
      true,
    );
    expect(direct.model.pools[0]!.process!.nodes.some((n) => n.generated)).toBe(
      false,
    );

    const wide = await compile(source, { layout: { nodeSpacing: 100 } });
    const x = (r: typeof joined) => r.layout.shapes.get('Event_end_1')?.x;
    expect(x(wide)).toBeGreaterThan(x(joined)!);
  });
});
