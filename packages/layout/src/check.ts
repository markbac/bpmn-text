import type { FlowNode, Model } from '@bpmn-text/core';
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
  const nodes: [FlowNode, Bounds][] = [];
  for (const p of model.pools) {
    for (const n of p.process?.nodes ?? []) {
      const shape = result.shapes.get(n.id);
      if (!shape) continue;
      nodes.push([n, shape]);
      if (n.attachedTo) continue;
      const band = result.shapes.get(n.laneId ?? p.id);
      if (band && !inside(shape, band)) {
        report.outsideLane++;
        report.problems.push(`${n.id} is outside ${n.laneId ?? p.id}`);
      }
    }
  }

  nodes.forEach(([a, sa], i) => {
    for (const [b, sb] of nodes.slice(i + 1)) {
      if (a.attachedTo === b.id || b.attachedTo === a.id) continue;
      if (overlap(sa, sb)) {
        report.overlaps++;
        report.problems.push(`${a.id} overlaps ${b.id}`);
      }
    }
  });

  const host = new Map(nodes.map(([n]) => [n.id, n.attachedTo]));
  const ends = new Map(
    [
      ...model.pools.flatMap((p) => p.process?.flows ?? []),
      ...model.messageFlows,
    ].map((f) => [f.id, [f.sourceRef, f.targetRef]]),
  );
  const edges = [...result.edges].map(
    ([id, e]) => [id, segments(e.waypoints)] as const,
  );
  for (const [id, segs] of edges) {
    report.bends += Math.max(0, segs.length - 1);
    for (const [a, b] of segs) {
      report.edgeLength += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    }
    const connected = (ends.get(id) ?? []).flatMap((e) => [e, host.get(e)]);
    for (const [n, shape] of nodes) {
      if (connected.includes(n.id)) continue;
      if (segs.some((s) => cuts(s, shape))) {
        report.edgeThroughShape++;
        report.problems.push(`${id} passes through ${n.id}`);
      }
    }
  }
  edges.forEach(([, a], i) => {
    for (const [, b] of edges.slice(i + 1)) {
      for (const s of a)
        for (const t of b) if (crosses(s, t)) report.crossings++;
    }
  });
  report.edgeLength = Math.round(report.edgeLength);

  const shapes = [...result.shapes.values()];
  if (shapes.length > 0) {
    const x1 = Math.min(...shapes.map((s) => s.x));
    const y1 = Math.min(...shapes.map((s) => s.y));
    const x2 = Math.max(...shapes.map((s) => s.x + s.width));
    const y2 = Math.max(...shapes.map((s) => s.y + s.height));
    report.area = Math.round((x2 - x1) * (y2 - y1));
  }
  return report;
}
