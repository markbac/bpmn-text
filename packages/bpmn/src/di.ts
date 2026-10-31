import type { Container, Model } from '@bpmn-text/core';
import type { Bounds, LayoutResult } from '@bpmn-text/layout';
import type { BpmnModdle, ModdleElement } from 'bpmn-moddle';
import type { Semantic } from './semantic.js';

/**
 * Adds diagram interchange to `semantic.definitions`: one plane for the
 * collaboration or process, and one for each collapsed subprocess whose
 * content the layout placed (architecture §7).
 */
export function addDiagrams(
  model: Model,
  layout: LayoutResult,
  { definitions, root, elements }: Semantic,
  moddle: BpmnModdle,
): void {
  const bounds = (b: Bounds) =>
    moddle.create('dc:Bounds', {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
    });
  // A subprocess is drawn expanded when its content is on the same plane.
  const expanded = new Set<string>();
  const subprocesses: [string, Container][] = [];
  const walk = (c: Container) => {
    for (const n of c.nodes) {
      if (n.kind !== 'subProcess' || !n.children) continue;
      if (n.collapsed) subprocesses.push([n.id, n.children]);
      else if (n.children.nodes.some((c) => layout.shapes.has(c.id)))
        expanded.add(n.id);
      walk(n.children);
    }
  };
  for (const p of model.pools) if (p.process) walk(p.process);

  function diagram(
    id: string,
    planeId: string,
    element: ModdleElement,
    ids: string[],
  ) {
    const planeElement: ModdleElement[] = [];
    for (const id of ids) {
      const shape = layout.shapes.get(id);
      const edge = layout.edges.get(id);
      const bpmnElement = elements.get(id)!;
      if (shape) {
        const attrs: Record<string, unknown> = {
          id: `${id}_di`,
          bpmnElement,
          bounds: bounds(shape),
        };
        const type = bpmnElement.$type;
        if (type === 'bpmn:Participant' || type === 'bpmn:Lane') {
          attrs.isHorizontal = true;
        }
        if (type === 'bpmn:SubProcess') attrs.isExpanded = expanded.has(id);
        if (shape.label) {
          attrs.label = moddle.create('bpmndi:BPMNLabel', {
            bounds: bounds(shape.label),
          });
        }
        planeElement.push(moddle.create('bpmndi:BPMNShape', attrs));
      } else if (edge) {
        const attrs: Record<string, unknown> = {
          id: `${id}_di`,
          bpmnElement,
          waypoint: edge.waypoints.map((p) =>
            moddle.create('dc:Point', { x: p.x, y: p.y }),
          ),
        };
        if (edge.label) {
          attrs.label = moddle.create('bpmndi:BPMNLabel', {
            bounds: bounds(edge.label),
          });
        }
        planeElement.push(moddle.create('bpmndi:BPMNEdge', attrs));
      }
    }
    return moddle.create('bpmndi:BPMNDiagram', {
      id,
      plane: moddle.create('bpmndi:BPMNPlane', {
        id: planeId,
        bpmnElement: element,
        planeElement,
      }),
    });
  }

  // Shapes before edges, so that bpmn-js draws edges on top.
  const ordered = (ids: Iterable<string>) => {
    const list = [...ids];
    return [
      ...list.filter((id) => layout.shapes.has(id)),
      ...list.filter((id) => layout.edges.has(id)),
    ];
  };
  const nested = new Set(
    subprocesses.flatMap(([, c]) => [
      ...c.nodes.map((n) => n.id),
      ...c.flows.map((f) => f.id),
    ]),
  );
  const main = [...layout.shapes.keys(), ...layout.edges.keys()].filter(
    (id) => !nested.has(id),
  );
  const diagrams = [
    diagram('BPMNDiagram_1', 'BPMNPlane_1', root, ordered(main)),
  ];
  for (const [id, c] of subprocesses) {
    const ids = [...c.nodes.map((n) => n.id), ...c.flows.map((f) => f.id)];
    if (!ids.some((i) => layout.shapes.has(i))) continue;
    diagrams.push(
      diagram(`${id}_diagram`, `${id}_plane`, elements.get(id)!, ordered(ids)),
    );
  }
  definitions.diagrams = diagrams;
}
