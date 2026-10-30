// Spike (#3): the questions the spike must answer, as numbers. A first cut
// of checkLayout (architecture §6.3, issue #23).
import type { SpikeModel } from './ir.ts';
import type { Bounds, Point, SpikeLayout } from './layout.ts';

export interface Metrics {
  /** Pairs of overlapping flow nodes. Must be 0. */
  overlaps: number;
  /** Flow nodes not inside their lane (or pool) band. Must be 0. */
  outsideBand: number;
  /** Forward flows (later in the story) drawn right to left. */
  storyInversions: number;
  /** Loops (flows back to an earlier step) and how many are back edges. */
  loops: number;
  loopsDrawnBack: number;
  /** Message flows whose target column is left of their source column. */
  messageInversions: number;
  /** Edge segments passing through a flow node they do not connect. */
  edgeThroughShape: number;
  /** Crossings between segments of different edges. */
  crossings: number;
  bends: number;
}

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

function segments(points: Point[]): [Point, Point][] {
  return points.slice(1).map((p, i) => [points[i]!, p]);
}

/** Whether an axis-parallel segment passes through the interior of `b`. */
function cuts([a, c]: [Point, Point], b: Bounds): boolean {
  const x1 = Math.min(a.x, c.x);
  const x2 = Math.max(a.x, c.x);
  const y1 = Math.min(a.y, c.y);
  const y2 = Math.max(a.y, c.y);
  return x1 < b.x + b.width && x2 > b.x && y1 < b.y + b.height && y2 > b.y;
}

function crosses([a, b]: [Point, Point], [c, d]: [Point, Point]): boolean {
  const h1 = a.y === b.y;
  const h2 = c.y === d.y;
  if (h1 === h2) return false;
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

export function measure(model: SpikeModel, layout: SpikeLayout): Metrics {
  const m: Metrics = {
    overlaps: 0,
    outsideBand: 0,
    storyInversions: 0,
    loops: 0,
    loopsDrawnBack: 0,
    messageInversions: 0,
    edgeThroughShape: 0,
    crossings: 0,
    bends: 0,
  };
  const nodes = [...layout.nodes];
  nodes.forEach(([, a], i) => {
    for (const [, b] of nodes.slice(i + 1)) if (overlap(a, b)) m.overlaps++;
  });

  for (const p of model.pools) {
    const position = new Map(p.nodes.map((n, i) => [n.id, i]));
    for (const n of p.nodes) {
      const band = layout.lanes.get(n.lane ?? '') ?? layout.pools.get(p.id)!;
      if (!inside(layout.nodes.get(n.id)!, band)) m.outsideBand++;
    }
    for (const f of p.flows) {
      const backwards =
        layout.nodes.get(f.target)!.column <=
        layout.nodes.get(f.source)!.column;
      if (position.get(f.target)! < position.get(f.source)!) {
        m.loops++;
        if (backwards) m.loopsDrawnBack++;
      } else if (backwards) {
        m.storyInversions++;
      }
    }
  }
  for (const f of model.messageFlows) {
    const s = layout.nodes.get(f.source);
    const t = layout.nodes.get(f.target);
    if (s && t && t.column < s.column) m.messageInversions++;
  }

  const flows = [...model.pools.flatMap((p) => p.flows), ...model.messageFlows];
  const segs = flows.map((f) => ({
    f,
    segs: segments(layout.edges.get(f.id)!),
  }));
  for (const { f, segs: ss } of segs) {
    m.bends += ss.length - 1;
    for (const [id, b] of nodes) {
      if (id === f.source || id === f.target) continue;
      if (ss.some((s) => cuts(s, b))) m.edgeThroughShape++;
    }
  }
  segs.forEach(({ segs: a }, i) => {
    for (const { segs: b } of segs.slice(i + 1)) {
      for (const s of a) for (const t of b) if (crosses(s, t)) m.crossings++;
    }
  });
  return m;
}
