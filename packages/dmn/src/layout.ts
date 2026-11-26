import {
  defaultElk,
  labelSize,
  type Bounds,
  type Elk,
  type Point,
  type Size,
} from '@bpmn-text/layout';
import type { DmnKind, DmnModel } from './model.js';

/** Positions of every DRD element and requirement, by ID. */
export interface DrdLayout {
  shapes: Map<string, Bounds>;
  edges: Map<string, Point[]>;
}

export interface DrdLayoutOptions {
  /** The ELK instance to use; see `LayoutOptions.elk`. */
  elk?: Elk;
}

/** dmn-js's default sizes (dmn-notation §6). */
const SIZES: Record<DmnKind, Size> = {
  decision: { width: 180, height: 80 },
  knowledge: { width: 135, height: 46 },
  input: { width: 125, height: 45 },
  source: { width: 100, height: 63 },
};
/** dmn-js draws names inside shapes in 12px Arial, with 5px padding. */
const FONT_SIZE = 12;
const LINE_HEIGHT = 15;
const PADDING = 5;
const MAX_WIDTH = 300;
const MARGIN = 20;

/** A shape big enough for its name: wider first, then taller. */
export function drdSize(kind: DmnKind, name: string): Size {
  let { width, height } = SIZES[kind];
  // The wavy bottom of a knowledge source takes a fifth of its height.
  const usable = (h: number) => (kind === 'source' ? h * 0.8 : h) - 2 * PADDING;
  const fits = (w: number) =>
    labelSize(name, w - 2 * PADDING, FONT_SIZE, LINE_HEIGHT);
  while (fits(width).height > usable(height) && width < MAX_WIDTH) width += 20;
  const text = fits(width);
  while (text.height > usable(height)) height += LINE_HEIGHT;
  return { width, height };
}

/**
 * Lays out the DRD: ELK layered, bottom to top, so input data sits at the
 * bottom and the decisions that use them above. Requirements are routed
 * orthogonally around the shapes.
 */
export async function layoutDrd(
  model: DmnModel,
  options: DrdLayoutOptions = {},
): Promise<DrdLayout> {
  const elk = options.elk ?? defaultElk;
  const ids = new Set(model.elements.map((e) => e.id));
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'UP',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '60',
      'elk.spacing.edgeNode': '20',
      'elk.spacing.componentComponent': '60',
    },
    children: model.elements.map((e) => ({
      id: e.id,
      ...drdSize(e.kind, e.name),
    })),
    edges: model.requirements
      .filter((r) => ids.has(r.from) && ids.has(r.to))
      .map((r) => ({ id: r.id, sources: [r.from], targets: [r.to] })),
  });
  const shapes = new Map<string, Bounds>();
  for (const n of graph.children ?? []) {
    shapes.set(n.id, {
      x: Math.round(n.x! + MARGIN),
      y: Math.round(n.y! + MARGIN),
      width: n.width!,
      height: n.height!,
    });
  }
  const edges = new Map<string, Point[]>();
  for (const e of graph.edges ?? []) {
    const s = (e as { sections?: ElkSection[] }).sections?.[0];
    if (!s) continue;
    const points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(
      (p) => ({ x: Math.round(p.x + MARGIN), y: Math.round(p.y + MARGIN) }),
    );
    edges.set(e.id, dedupe(points));
  }
  return { shapes, edges };
}

interface ElkSection {
  startPoint: Point;
  endPoint: Point;
  bendPoints?: Point[];
}

/** Drops repeated points, which rounding can make. */
function dedupe(points: Point[]): Point[] {
  return points.filter(
    (p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y,
  );
}

export interface DrdLayoutReport {
  problems: string[];
  /** The area of the bounding box of all shapes. */
  area: number;
  /** The total length of all requirement routes. */
  edgeLength: number;
  /** Bends in requirement routes. */
  bends: number;
  /** Pairs of requirement routes that cross each other. */
  crossings: number;
}

/**
 * Checks the invariants every DRD layout must keep: shapes do not overlap,
 * and no requirement passes through a shape other than its two ends.
 */
export function checkDrdLayout(
  model: DmnModel,
  layout: DrdLayout,
): DrdLayoutReport {
  const problems: string[] = [];
  const shapes = [...layout.shapes];
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const [a, ra] = shapes[i]!;
      const [b, rb] = shapes[j]!;
      if (overlaps(ra, rb)) problems.push(`${a} overlaps ${b}`);
    }
  }
  for (const r of model.requirements) {
    const points = layout.edges.get(r.id);
    if (!points) {
      problems.push(`${r.id} has no route`);
      continue;
    }
    for (const [id, box] of shapes) {
      if (id === r.from || id === r.to) continue;
      for (let k = 1; k < points.length; k++) {
        if (crosses(points[k - 1]!, points[k]!, box)) {
          problems.push(`${r.id} passes through ${id}`);
          break;
        }
      }
    }
  }
  const boxes = [...layout.shapes.values()];
  const right = Math.max(0, ...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(0, ...boxes.map((b) => b.y + b.height));
  const left = Math.min(right, ...boxes.map((b) => b.x));
  const top = Math.min(bottom, ...boxes.map((b) => b.y));
  const routes = [...layout.edges.values()];
  const segments = routes.map((r) =>
    r.slice(1).map((q, k) => [r[k]!, q] as const),
  );
  let crossings = 0;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const cross = segments[i]!.some(([a, b]) =>
        segments[j]!.some(([c, d]) => properlyCross(a, b, c, d)),
      );
      if (cross) crossings++;
    }
  }
  const length = (r: Point[]) =>
    r
      .slice(1)
      .reduce((s, q, k) => s + Math.hypot(q.x - r[k]!.x, q.y - r[k]!.y), 0);
  return {
    problems,
    area: (right - left) * (bottom - top),
    edgeLength: Math.round(routes.reduce((s, r) => s + length(r), 0)),
    bends: routes.reduce((s, r) => s + Math.max(0, r.length - 2), 0),
    crossings,
  };
}

/** Whether two segments cross at a point inside both. */
function properlyCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const turn = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0;
}

const overlaps = (a: Bounds, b: Bounds) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/** Whether an axis-aligned or straight segment enters the inside of `box`. */
function crosses(p: Point, q: Point, box: Bounds): boolean {
  const inset = 1;
  const x0 = box.x + inset;
  const y0 = box.y + inset;
  const x1 = box.x + box.width - inset;
  const y1 = box.y + box.height - inset;
  // Liang–Barsky clipping of the segment against the box.
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  for (const [pk, qk] of [
    [-dx, p.x - x0],
    [dx, x1 - p.x],
    [-dy, p.y - y0],
    [dy, y1 - p.y],
  ] as const) {
    if (pk === 0) {
      if (qk < 0) return false;
      continue;
    }
    const t = qk / pk;
    if (pk < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return t1 - t0 > 1e-9;
}
