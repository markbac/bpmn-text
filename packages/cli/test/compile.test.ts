import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.js';

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
