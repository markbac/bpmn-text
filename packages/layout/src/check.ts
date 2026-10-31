import type { Container, FlowNode, Model } from '@bpmn-text/core';
import type { Bounds, LayoutResult, Point } from './types.js';

export interface LayoutReport {
  /** Pairs of overlapping flow nodes. Must be 0. */
  overlaps: number;
  /** Flow nodes not inside their lane, or their pool's band. Must be 0. */
  outsideLane: number;
  /** Edges passing through a flow node they do not connect. Must be 0. */
  edgeThroughShape: number;
  /** Crossings between segments of different edges. */
  crossings: number;
  bends: number;
  /** Total length of all edges, rounded to whole pixels. */
  edgeLength: number;
  /** Width × height of the bounding box of all shapes. */
  area: number;
  /** One line for each broken invariant, naming the elements. */
  problems: string[];
}

type Segment = [Point, Point];

const segments = (points: Point[]): Segment[] =>
  points.slice(1).map((p, i) => [points[i]!, p]);

const inside = (a: Bounds, b: Bounds) =>
  a.x >= b.x &&
  a.y >= b.y &&
  a.x + a.width <= b.x + b.width &&
  a.y + a.height <= b.y + b.height;

const overlap = (a: Bounds, b: Bounds) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/** Whether an axis-parallel segment passes through the interior of `b`. */
function cuts([a, c]: Segment, b: Bounds): boolean {
  const [x1, x2] = [Math.min(a.x, c.x), Math.max(a.x, c.x)];
  const [y1, y2] = [Math.min(a.y, c.y), Math.max(a.y, c.y)];
  return x1 < b.x + b.width && x2 > b.x && y1 < b.y + b.height && y2 > b.y;
}

/** Whether a horizontal and a vertical segment cross in their interiors. */
function crosses([a, b]: Segment, [c, d]: Segment): boolean {
  const h1 = a.y === b.y;
  if (h1 === (c.y === d.y)) return false;
  const [h, v] = h1
    ? [
        [a, b],
        [c, d],
      ]
    : [
        [c, d],
        [a, b],
      ];
  const [hx1, hx2] = [Math.min(h[0]!.x, h[1]!.x), Math.max(h[0]!.x, h[1]!.x)];
  const [vy1, vy2] = [Math.min(v[0]!.y, v[1]!.y), Math.max(v[0]!.y, v[1]!.y)];
  return v[0]!.x > hx1 && v[0]!.x < hx2 && h[0]!.y > vy1 && h[0]!.y < vy2;
}

interface Item {
  id: string;
  bounds: Bounds;
  /** Boundary events: their host. */
  host?: string;
  /** The subprocess whose body this is in. */
  parent?: string;
  /** Top-level flow nodes: the band they must stay in. */
  band?: string;
  /** Flow nodes, as opposed to data and annotations. */
  node: boolean;
}

interface Plane {
  items: Item[];
  /** Edge IDs with the element IDs at each end. */
  edges: Map<string, string[]>;
}

/**
 * Splits the drawn elements into diagram planes: the main one, and one per
 * collapsed subprocess.
 */
function planes(model: Model, result: LayoutResult): Plane[] {
  const list: Plane[] = [{ items: [], edges: new Map() }];
  const associations: [string, string, string][] = [];
  /** Each subprocess body's plane, and the subprocess it is drawn in. */
  const bodies = new Map<string, [Plane, string | undefined]>();
  const add = (plane: Plane, item: Omit<Item, 'bounds'>) => {
    const bounds = result.shapes.get(item.id);
    if (bounds) plane.items.push({ ...item, bounds });
  };
  const walk = (
    c: Container,
    plane: Plane,
    parent: string | undefined,
    band: (n: FlowNode) => string | undefined,
  ) => {
    for (const n of c.nodes) {
      add(plane, {
        id: n.id,
        node: true,
        ...(n.attachedTo ? { host: n.attachedTo } : {}),
        ...(parent ? { parent } : {}),
        ...(!n.attachedTo && band(n) ? { band: band(n)! } : {}),
      });
      for (const a of n.reads) associations.push([a.id, a.dataRef, n.id]);
      for (const a of n.writes) associations.push([a.id, n.id, a.dataRef]);
      if (!n.children) continue;
      const own: Plane = n.collapsed ? { items: [], edges: new Map() } : plane;
      if (n.collapsed) list.push(own);
      const inner = n.collapsed ? undefined : n.id;
      bodies.set(n.id, [own, inner]);
      walk(n.children, own, inner, () => undefined);
    }
    for (const a of c.annotations) {
      add(plane, { id: a.id, node: false, ...(parent ? { parent } : {}) });
      plane.edges.set(a.association, [a.attachedTo, a.id]);
    }
    for (const f of c.flows) plane.edges.set(f.id, [f.sourceRef, f.targetRef]);
  };
  for (const p of model.pools) {
    if (p.process)
      walk(p.process, list[0]!, undefined, (n) => n.laneId ?? p.id);
  }
  // Data references, in the body that holds them.
  for (const p of model.pools) {
    for (const [id, container] of [
      ...(p.process?.dataObjects ?? []).map((o) => [o.reference, o.container]),
      ...(p.process?.dataStoreReferences ?? []).map((r) => [r.id, r.container]),
    ] as [string, string | undefined][]) {
      const [plane, parent] = container
        ? (bodies.get(container) ?? [list[0]!, undefined])
        : [list[0]!, undefined];
      add(plane, { id, node: false, ...(parent ? { parent } : {}) });
    }
  }
  for (const plane of list) {
    const ids = new Set(plane.items.map((i) => i.id));
    for (const [id, from, to] of associations) {
      if (ids.has(from) && ids.has(to) && result.edges.has(id))
        plane.edges.set(id, [from, to]);
    }
  }
  for (const f of model.messageFlows)
    list[0]!.edges.set(f.id, [f.sourceRef, f.targetRef]);
  return list;
}

/**
 * Checks the layout invariants and measures its quality (architecture
 * §6.3), for tests and benchmarks.
 */
export function checkLayout(model: Model, result: LayoutResult): LayoutReport {
  const report: LayoutReport = {
    overlaps: 0,
    outsideLane: 0,
    edgeThroughShape: 0,
    crossings: 0,
    bends: 0,
    edgeLength: 0,
    area: 0,
    problems: [],
  };
  const all = planes(model, result);
  for (const { items, edges: planeEdges } of all) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const ancestors = (id: string): string[] => {
      const parent = byId.get(id)?.parent;
      return parent ? [parent, ...ancestors(parent)] : [];
    };
    for (const item of items) {
      const container = item.parent ?? item.band;
      const outer = container && result.shapes.get(container);
      if (item.host || !outer || inside(item.bounds, outer)) continue;
      report.outsideLane++;
      report.problems.push(`${item.id} is outside ${container}`);
    }

    items.forEach((a, i) => {
      for (const b of items.slice(i + 1)) {
        if (a.host === b.id || b.host === a.id) continue;
        if (ancestors(a.id).includes(b.id) || ancestors(b.id).includes(a.id))
          continue;
        if (overlap(a.bounds, b.bounds)) {
          report.overlaps++;
          report.problems.push(`${a.id} overlaps ${b.id}`);
        }
      }
    });

    const edges = [...planeEdges.keys()].flatMap((id) => {
      const e = result.edges.get(id);
      return e ? [[id, segments(e.waypoints)] as const] : [];
    });
    for (const [id, segs] of edges) {
      report.bends += Math.max(0, segs.length - 1);
      for (const [a, b] of segs) {
        report.edgeLength += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      }
      const connected = (planeEdges.get(id) ?? []).flatMap((e) => [
        e,
        byId.get(e)?.host,
        ...ancestors(e),
        ...ancestors(byId.get(e)?.host ?? ''),
      ]);
      for (const item of items) {
        if (connected.includes(item.id)) continue;
        if (segs.some((s) => cuts(s, item.bounds))) {
          report.edgeThroughShape++;
          report.problems.push(`${id} passes through ${item.id}`);
        }
      }
    }
    edges.forEach(([, a], i) => {
      for (const [, b] of edges.slice(i + 1)) {
        for (const s of a)
          for (const t of b) if (crosses(s, t)) report.crossings++;
      }
    });
  }
  report.edgeLength = Math.round(report.edgeLength);

  // Groups: only members inside the box, and no shape cut by its border.
  const main = all[0]!.items;
  for (const g of model.groups) {
    const box = result.shapes.get(g.id);
    if (!box) continue;
    for (const item of main) {
      if (!overlap(item.bounds, box)) continue;
      if (!inside(item.bounds, box)) {
        report.overlaps++;
        report.problems.push(`The border of ${g.id} crosses ${item.id}`);
      } else if (item.node && !item.parent && !g.members.includes(item.id)) {
        report.overlaps++;
        report.problems.push(`${item.id} is inside ${g.id}, not a member`);
      }
    }
  }

  const shapes = [
    ...model.pools.flatMap((p) =>
      [p.id, ...p.lanes.map((l) => l.id)].flatMap((id) => {
        const s = result.shapes.get(id);
        return s ? [s] : [];
      }),
    ),
    ...main.map((i) => i.bounds),
    ...model.groups.flatMap((g) => {
      const s = result.shapes.get(g.id);
      return s ? [s] : [];
    }),
  ];
  if (shapes.length > 0) {
    const x1 = Math.min(...shapes.map((s) => s.x));
    const y1 = Math.min(...shapes.map((s) => s.y));
    const x2 = Math.max(...shapes.map((s) => s.x + s.width));
    const y2 = Math.max(...shapes.map((s) => s.y + s.height));
    report.area = Math.round((x2 - x1) * (y2 - y1));
  }
  return report;
}
