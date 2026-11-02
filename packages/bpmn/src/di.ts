import { schemeStyles } from '@bpmn-text/core';
import type { Container, Model, Style } from '@bpmn-text/core';
import type { Bounds, LayoutResult } from '@bpmn-text/layout';
import type { BpmnModdle, ModdleElement } from 'bpmn-moddle';
import type { Semantic } from './semantic.js';

/** How much of its fill bpmn-js lets show through on a lane. */
const LANE_OPACITY = 0.25;

/**
 * bpmn-js draws a pool's fill nearly solid but a lane's at a quarter strength,
 * so a pool's colour is written as the tint it would have on a lane.
 */
function poolFill(fill: string): string {
  const tint = (from: number) =>
    Math.round(
      255 - (255 - parseInt(fill.slice(from, from + 2), 16)) * LANE_OPACITY,
    )
      .toString(16)
      .padStart(2, '0');
  return `#${tint(1)}${tint(3)}${tint(5)}`.toUpperCase();
}

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

  // Colours (ADR-011): shapes by their own style, over what `option colors`
  // picks; edges by the stroke written on their source element.
  const scheme = schemeStyles(model);
  const styles = new Map<string, Style>();
  const edgeSource = new Map<string, string>();
  const styled = (c: Container) => {
    for (const n of c.nodes) {
      if (n.style) styles.set(n.id, n.style);
      if (n.children) styled(n.children);
    }
    for (const f of c.flows) edgeSource.set(f.id, f.sourceRef);
    for (const a of c.annotations) if (a.style) styles.set(a.id, a.style);
  };
  const stores = new Map(model.dataStores.map((s) => [s.id, s]));
  for (const p of model.pools) {
    const own = { ...scheme.get(p.id), ...p.style };
    // A lane takes its pool's colours unless it has its own. Over the pool's
    // tint it looks the same as the pool, which the header shows. A lane
    // with a fill of its own would mix with that tint, turning orange on navy
    // grey, so then the pool has no fill and its other lanes the colour itself.
    const mixes = p.lanes.some((l) => l.style?.fill);
    const inherited = { ...(p.style && own) };
    if (own.fill) {
      if (mixes) delete own.fill;
      else inherited.fill = own.fill = poolFill(own.fill);
    }
    if (own.fill || own.stroke) styles.set(p.id, own);
    for (const l of p.lanes) {
      const lane = { ...inherited, ...l.style };
      if (lane.fill || lane.stroke) styles.set(l.id, lane);
    }
    if (!p.process) continue;
    styled(p.process);
    const objects = new Map(p.process.dataObjects.map((o) => [o.id, o]));
    for (const r of p.process.dataObjectReferences) {
      const style = objects.get(r.object)?.style;
      if (style) styles.set(r.id, style);
    }
    for (const r of p.process.dataStoreReferences) {
      const style = stores.get(r.store)?.style;
      if (style) styles.set(r.id, style);
    }
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
        const style = { ...scheme.get(id), ...styles.get(id) };
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
        if (type === 'bpmn:SubProcess' || type === 'bpmn:AdHocSubProcess')
          attrs.isExpanded = expanded.has(id);
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

  // Each element's plane: a collapsed subprocess's, or the main one.
  const planeOf = new Map<string, string | undefined>();
  const assign = (c: Container, plane: string | undefined) => {
    for (const n of c.nodes) {
      planeOf.set(n.id, plane);
      for (const a of [...n.reads, ...n.writes]) planeOf.set(a.id, plane);
      if (n.children) assign(n.children, n.collapsed ? n.id : plane);
    }
    for (const f of c.flows) planeOf.set(f.id, plane);
    for (const a of c.annotations) {
      planeOf.set(a.id, plane);
      planeOf.set(a.association, plane);
    }
  };
  for (const p of model.pools) if (p.process) assign(p.process, undefined);
  for (const p of model.pools) {
    for (const d of [
      ...(p.process?.dataObjectReferences ?? []).map((o) => [
        o.id,
        o.container,
      ]),
      ...(p.process?.dataStoreReferences ?? []).map((r) => [r.id, r.container]),
    ] as [string, string | undefined][]) {
      const [id, container] = d;
      const sub = subprocesses.find(([s]) => s === container);
      planeOf.set(id, sub ? container : container && planeOf.get(container));
    }
  }

  // Shapes before edges, so that bpmn-js draws edges on top.
  const ordered = (ids: Iterable<string>) => {
    const list = [...ids];
    return [
      ...list.filter((id) => layout.shapes.has(id)),
      ...list.filter((id) => layout.edges.has(id)),
    ];
  };
  const all = [...layout.shapes.keys(), ...layout.edges.keys()];
  const diagrams = [
    diagram(
      'BPMNDiagram_1',
      'BPMNPlane_1',
      root,
      ordered(all.filter((id) => planeOf.get(id) === undefined)),
    ),
  ];
  for (const [id] of subprocesses) {
    const ids = all.filter((i) => planeOf.get(i) === id);
    if (!ids.some((i) => layout.shapes.has(i))) continue;
    diagrams.push(
      diagram(`${id}_diagram`, `${id}_plane`, elements.get(id)!, ordered(ids)),
    );
  }
  definitions.diagrams = diagrams;
}
