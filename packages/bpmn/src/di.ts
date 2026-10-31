import type { Container, Model, Style } from '@bpmn-text/core';
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

  // Colours (ADR-011): shapes by their own style, edges by the stroke of
  // their source element.
  const styles = new Map<string, Style>();
  const edgeSource = new Map<string, string>();
  const styled = (c: Container) => {
    for (const n of c.nodes) {
      if (n.style) styles.set(n.id, n.style);
      if (n.children) styled(n.children);
    }
    for (const f of c.flows) edgeSource.set(f.id, f.sourceRef);
  };
  for (const p of model.pools) {
    if (p.style) styles.set(p.id, p.style);
    for (const l of p.lanes) if (l.style) styles.set(l.id, l.style);
    if (p.process) styled(p.process);
  }
  for (const g of model.groups) if (g.style) styles.set(g.id, g.style);
  for (const f of model.messageFlows) edgeSource.set(f.id, f.sourceRef);
  const colours = (style: Style | undefined, edge: boolean) => {
    const attrs: Record<string, string> = {};
    if (style?.fill && !edge) {
      attrs['bioc:fill'] = style.fill;
      attrs['color:background-color'] = style.fill;
    }
    if (style?.stroke) {
      attrs['bioc:stroke'] = style.stroke;
      attrs['color:border-color'] = style.stroke;
    }
    return attrs;
  };
  const labelColour = (style: Style | undefined) =>
    style?.stroke ? { 'color:color': style.stroke } : {};

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
        const style = styles.get(id);
        const attrs: Record<string, unknown> = {
          id: `${id}_di`,
          bpmnElement,
          bounds: bounds(shape),
          ...colours(style, false),
        };
        const type = bpmnElement.$type;
        if (type === 'bpmn:Participant' || type === 'bpmn:Lane') {
          attrs.isHorizontal = true;
        }
        if (type === 'bpmn:SubProcess') attrs.isExpanded = expanded.has(id);
        if (shape.label) {
          attrs.label = moddle.create('bpmndi:BPMNLabel', {
            bounds: bounds(shape.label),
            ...labelColour(style),
          });
        }
        planeElement.push(moddle.create('bpmndi:BPMNShape', attrs));
      } else if (edge) {
        const source = edgeSource.get(id);
        const style = source ? styles.get(source) : undefined;
        const attrs: Record<string, unknown> = {
          id: `${id}_di`,
          bpmnElement,
          waypoint: edge.waypoints.map((p) =>
            moddle.create('dc:Point', { x: p.x, y: p.y }),
          ),
          ...colours(style, true),
        };
        if (edge.label) {
          attrs.label = moddle.create('bpmndi:BPMNLabel', {
            bounds: bounds(edge.label),
            ...labelColour(style),
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
