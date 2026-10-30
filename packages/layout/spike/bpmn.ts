// Spike (#3): writes a SpikeModel and its layout as BPMN 2.0 XML with DI.
// String templates are enough to inspect the layout in bpmn.io; the real
// generator (#17, #24) uses bpmn-moddle.
import type { Kind, SpikeModel } from './ir.ts';
import type { Bounds, SpikeLayout } from './layout.ts';

const tag: Record<Kind, string> = {
  start: 'startEvent',
  end: 'endEvent',
  task: 'task',
  user: 'userTask',
  service: 'serviceTask',
  send: 'sendTask',
  receive: 'receiveTask',
  xor: 'exclusiveGateway',
  and: 'parallelGateway',
  or: 'inclusiveGateway',
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const name = (n?: string) => (n ? ` name="${esc(n)}"` : '');
const bounds = (b: Bounds) =>
  `<dc:Bounds x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" />`;

export function toXml(model: SpikeModel, layout: SpikeLayout): string {
  const out: string[] = [];
  const processId = (poolId: string) =>
    poolId.replace('Participant_', 'Process_');
  const expanded = model.pools.filter((p) => !p.collapsed);

  if (!model.implicitPool) {
    out.push(`  <bpmn:collaboration id="Collaboration_1"${name(model.title)}>`);
    for (const p of model.pools) {
      const ref = p.collapsed ? '' : ` processRef="${processId(p.id)}"`;
      out.push(`    <bpmn:participant id="${p.id}"${name(p.name)}${ref} />`);
    }
    for (const f of model.messageFlows) {
      out.push(
        `    <bpmn:messageFlow id="${f.id}"${name(f.name)} sourceRef="${f.source}" targetRef="${f.target}" />`,
      );
    }
    out.push('  </bpmn:collaboration>');
  }

  for (const p of expanded) {
    out.push(`  <bpmn:process id="${processId(p.id)}" isExecutable="false">`);
    if (p.lanes.length) {
      out.push(`    <bpmn:laneSet id="LaneSet_${p.id}">`);
      for (const l of p.lanes) {
        out.push(`      <bpmn:lane id="${l.id}"${name(l.name)}>`);
        for (const n of p.nodes.filter((n) => n.lane === l.id)) {
          out.push(`        <bpmn:flowNodeRef>${n.id}</bpmn:flowNodeRef>`);
        }
        out.push('      </bpmn:lane>');
      }
      out.push('    </bpmn:laneSet>');
    }
    for (const n of p.nodes) {
      const dflt = p.flows.find((f) => f.source === n.id && f.isDefault);
      out.push(
        `    <bpmn:${tag[n.kind]} id="${n.id}"${name(n.name)}${dflt ? ` default="${dflt.id}"` : ''}>`,
      );
      for (const f of p.flows.filter((f) => f.target === n.id)) {
        out.push(`      <bpmn:incoming>${f.id}</bpmn:incoming>`);
      }
      for (const f of p.flows.filter((f) => f.source === n.id)) {
        out.push(`      <bpmn:outgoing>${f.id}</bpmn:outgoing>`);
      }
      out.push(`    </bpmn:${tag[n.kind]}>`);
    }
    for (const f of p.flows) {
      out.push(
        `    <bpmn:sequenceFlow id="${f.id}"${name(f.name)} sourceRef="${f.source}" targetRef="${f.target}" />`,
      );
    }
    out.push('  </bpmn:process>');
  }

  const plane = model.implicitPool
    ? processId(model.pools[0]!.id)
    : 'Collaboration_1';
  out.push('  <bpmndi:BPMNDiagram id="Diagram_1">');
  out.push(`    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="${plane}">`);
  const shape = (id: string, b: Bounds, extra = '') =>
    out.push(
      `      <bpmndi:BPMNShape id="${id}_di" bpmnElement="${id}"${extra}>${bounds(b)}</bpmndi:BPMNShape>`,
    );
  if (!model.implicitPool) {
    for (const [id, b] of layout.pools) shape(id, b, ' isHorizontal="true"');
    for (const [id, b] of layout.lanes) shape(id, b, ' isHorizontal="true"');
  }
  for (const [id, b] of layout.nodes) shape(id, b);
  for (const [id, points] of layout.edges) {
    out.push(`      <bpmndi:BPMNEdge id="${id}_di" bpmnElement="${id}">`);
    for (const pt of points)
      out.push(`        <di:waypoint x="${pt.x}" y="${pt.y}" />`);
    out.push('      </bpmndi:BPMNEdge>');
  }
  out.push('    </bpmndi:BPMNPlane>');
  out.push('  </bpmndi:BPMNDiagram>');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"',
    '    xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"',
    '    xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"',
    '    xmlns:di="http://www.omg.org/spec/DD/20100524/DI"',
    '    id="Definitions_1" targetNamespace="http://bpmn-text.dev/spike">',
    ...out,
    '</bpmn:definitions>',
    '',
  ].join('\n');
}
