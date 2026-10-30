// Spike (#3): option A of ADR-004. ELK layers and orders every flow node of
// every pool in one graph; custom code then stacks lanes as bands, assigns
// rows and coordinates, and routes flows orthogonally.
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Kind, SpikeModel, SpikeNode } from './ir.ts';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Placed extends Bounds {
  column: number;
  row: number;
}
export interface SpikeLayout {
  nodes: Map<string, Placed>;
  pools: Map<string, Bounds>;
  lanes: Map<string, Bounds>;
  edges: Map<string, Point[]>;
}

const POOL_LABEL = 30;
const LANE_LABEL = 30;
const PAD_X = 40;
const PAD_Y = 25;
const ROW_H = 110;
const GUTTER = 30; // under the rows of a lane that has back edges
const COLUMN_GAP = 50;
const TRACK = 12; // channel width per vertical segment routed through it
const STUB = 15; // short segment leaving a shape before turning
const POOL_GAP = 50;
const COLLAPSED_H = 60;

export function size(kind: Kind): { width: number; height: number } {
  if (kind === 'start' || kind === 'end') return { width: 36, height: 36 };
  if (kind === 'xor' || kind === 'and' || kind === 'or') {
    return { width: 50, height: 50 };
  }
  return { width: 100, height: 80 };
}
const isGateway = (n: SpikeNode) =>
  n.kind === 'xor' || n.kind === 'and' || n.kind === 'or';

/**
 * A single story order over all pools: each pool's document order, merged
 * so that a message flow's target comes after its source where possible.
 * ELK's model-order cycle breaking then reverses only real loops, not
 * message flows from a later pool to an earlier one.
 */
export function storyOrder(model: SpikeModel): SpikeNode[] {
  const pools = model.pools.filter((p) => !p.collapsed);
  const key = new Map<string, [number, number]>();
  pools.forEach((p, pi) => p.nodes.forEach((n, i) => key.set(n.id, [pi, i])));
  const before = new Map<string, Set<string>>(
    [...key.keys()].map((id) => [id, new Set()]),
  );
  for (const p of pools) {
    for (const f of p.flows) {
      if (key.get(f.source)![1] < key.get(f.target)![1])
        before.get(f.target)!.add(f.source);
    }
  }
  for (const f of model.messageFlows) {
    if (key.has(f.source) && key.has(f.target))
      before.get(f.target)!.add(f.source);
  }
  const byId = new Map(pools.flatMap((p) => p.nodes.map((n) => [n.id, n])));
  const done = new Set<string>();
  const result: SpikeNode[] = [];
  const rank = (id: string) => key.get(id)![0] * 1e6 + key.get(id)![1];
  while (result.length < key.size) {
    const open = [...key.keys()].filter((id) => !done.has(id));
    const ready = open.filter((id) =>
      [...before.get(id)!].every((b) => done.has(b)),
    );
    // A cycle through message flows: fall back to document order.
    const next = (ready.length ? ready : open).sort(
      (a, b) => rank(a) - rank(b),
    )[0]!;
    done.add(next);
    result.push(byId.get(next)!);
  }
  return result;
}

/** Phase 2: one ELK layered graph over all pools. Returns node → column. */
export async function layer(
  model: SpikeModel,
  elkOptions: Record<string, string> = {},
): Promise<{ column: Map<string, number>; order: Map<string, number> }> {
  const nodes = storyOrder(model);
  const ids = new Set(nodes.map((n) => n.id));
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
      'elk.spacing.nodeNode': '30',
      'elk.layered.spacing.nodeNodeBetweenLayers': '50',
      ...elkOptions,
    },
    children: nodes.map((n) => ({ id: n.id, ...size(n.kind) })),
    edges: [
      ...model.pools
        .flatMap((p) => p.flows)
        .map((f) => ({
          id: f.id,
          sources: [f.source],
          targets: [f.target],
          layoutOptions: { 'elk.layered.priority.shortness': '10' },
        })),
      // Message flows between flow nodes only align columns across pools.
      ...model.messageFlows
        .filter((f) => ids.has(f.source) && ids.has(f.target))
        .map((f) => ({
          id: f.id,
          sources: [f.source],
          targets: [f.target],
          layoutOptions: { 'elk.layered.priority.shortness': '0' },
        })),
    ],
  };
  const result = await new ELK.default().layout(graph);
  // ELK reports coordinates, not layer indices: nodes whose x ranges
  // overlap share a layer.
  const placed = [...(result.children ?? [])].sort((a, b) => a.x! - b.x!);
  const column = new Map<string, number>();
  const order = new Map<string, number>();
  let current = -1;
  let right = -Infinity;
  for (const n of placed) {
    if (n.x! >= right) {
      current++;
      right = n.x! + n.width!;
    } else {
      right = Math.max(right, n.x! + n.width!);
    }
    column.set(n.id, current);
    order.set(n.id, n.y!);
  }
  return { column, order };
}

const cx = (b: Bounds) => b.x + b.width / 2;
const cy = (b: Bounds) => b.y + b.height / 2;

export async function layout(
  model: SpikeModel,
  elkOptions?: Record<string, string>,
): Promise<SpikeLayout> {
  const { column, order } = await layer(model, elkOptions);
  const all = model.pools.flatMap((p) => p.nodes);
  const byId = new Map(all.map((n) => [n.id, n]));
  const flows = model.pools.flatMap((p) => p.flows);
  const columns = Math.max(...column.values()) + 1;
  const col = (id: string) => column.get(id)!;
  const isBack = (f: { source: string; target: string }) =>
    col(f.target) <= col(f.source);
  const poolOf = (id: string) =>
    model.pools.find((p) => p.id === id || p.nodes.some((n) => n.id === id))!;

  // Phase 3: rows. Within a lane and column, nodes stack in ELK order.
  const bandOf = new Map(
    model.pools.flatMap((p) => p.nodes.map((n) => [n.id, n.lane ?? p.id])),
  );
  const row = new Map<string, number>();
  const bandRows = new Map<string, number>();
  const cells = new Map<string, SpikeNode[]>();
  for (const n of all) {
    const k = `${bandOf.get(n.id)}|${col(n.id)}`;
    cells.set(k, [...(cells.get(k) ?? []), n]);
  }
  for (const [k, cell] of cells) {
    cell.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    cell.forEach((n, i) => row.set(n.id, i));
    const band = k.split('|')[0]!;
    bandRows.set(band, Math.max(bandRows.get(band) ?? 0, cell.length));
  }
  const colWidth = Array.from({ length: columns }, (_, c) =>
    Math.max(
      ...all.filter((n) => col(n.id) === c).map((n) => size(n.kind).width),
    ),
  );

  // Phase 4: coordinates, given the number of tracks in each channel.
  function place(tracks: number[]) {
    const colX: number[] = [];
    let x = POOL_LABEL + LANE_LABEL + PAD_X;
    for (let c = 0; c < columns; c++) {
      colX.push(x);
      x += colWidth[c]! + COLUMN_GAP + tracks[c]! * TRACK;
    }
    const width = x - COLUMN_GAP + PAD_X;
    const nodes = new Map<string, Placed>();
    const pools = new Map<string, Bounds>();
    const lanes = new Map<string, Bounds>();
    const bands = new Map<string, Bounds>();
    let y = 0;
    for (const p of model.pools) {
      if (p.collapsed) {
        pools.set(p.id, { x: 0, y, width, height: COLLAPSED_H });
        y += COLLAPSED_H + POOL_GAP;
        continue;
      }
      const top = y;
      for (const band of p.lanes.length ? p.lanes.map((l) => l.id) : [p.id]) {
        const gutter = flows.some(
          (f) => isBack(f) && bandOf.get(f.source) === band,
        );
        const height =
          Math.max(bandRows.get(band) ?? 1, 1) * ROW_H +
          2 * PAD_Y +
          (gutter ? GUTTER : 0);
        const b = { x: POOL_LABEL, y, width: width - POOL_LABEL, height };
        bands.set(band, b);
        if (p.lanes.length) lanes.set(band, b);
        y += height;
      }
      pools.set(p.id, { x: 0, y: top, width, height: y - top });
      y += POOL_GAP;
    }
    for (const n of all) {
      const band = bands.get(bandOf.get(n.id)!)!;
      const s = size(n.kind);
      const c = col(n.id);
      const r = row.get(n.id)!;
      nodes.set(n.id, {
        x: colX[c]! + (colWidth[c]! - s.width) / 2,
        y: band.y + PAD_Y + r * ROW_H + (ROW_H - s.height) / 2,
        ...s,
        column: c,
        row: r,
      });
    }
    return { colX, nodes, pools, lanes, bands };
  }

  // Phases 5 and 6: routing. `channel(c)` hands out the x of the next free
  // track between column c and c + 1. Which channels an edge uses depends
  // only on columns and rows, so routing once with no tracks counts them,
  // and routing again on the widened geometry gives the final points.
  function route(
    geo: ReturnType<typeof place>,
    channel: (c: number) => number,
  ) {
    const { nodes, pools, bands } = geo;
    const edges = new Map<string, Point[]>();
    const clear = (a: Point, b: Point, ignore: string[]) =>
      [...nodes].every(([id, n]) => {
        if (ignore.includes(id)) return true;
        const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
        const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
        return !(
          x1 < n.x + n.width &&
          x2 > n.x &&
          y1 < n.y + n.height &&
          y2 > n.y
        );
      });
    const rowGap = (id: string) => {
      const n = nodes.get(id)!;
      return bands.get(bandOf.get(id)!)!.y + PAD_Y + (n.row + 1) * ROW_H;
    };

    for (const f of flows) {
      const ends = [f.source, f.target];
      const s = nodes.get(f.source)!;
      const t = nodes.get(f.target)!;
      const sg = isGateway(byId.get(f.source)!);
      const tg = isGateway(byId.get(f.target)!);
      const right = { x: s.x + s.width, y: cy(s) };
      const left = { x: t.x, y: cy(t) };
      let points: Point[];
      if (isBack(f)) {
        // Leave from the bottom and run back along the lane gutter.
        const band = bands.get(bandOf.get(f.source)!)!;
        const gy = band.y + band.height - GUTTER / 2;
        points = [
          { x: cx(s), y: s.y + s.height },
          { x: cx(s), y: gy },
          { x: cx(t), y: gy },
          { x: cx(t), y: t.y + t.height },
        ];
      } else if (cy(s) === cy(t) && clear(right, left, ends)) {
        points = [right, left];
      } else if (cy(s) === cy(t)) {
        // Same row with shapes in between: detour through the row gap.
        const gy = rowGap(f.source);
        const head = sg
          ? [{ x: cx(s), y: s.y + s.height }]
          : [right, { x: channel(col(f.source)), y: cy(s) }];
        const tail = tg
          ? [{ x: cx(t), y: t.y + t.height }]
          : [{ x: channel(col(f.target) - 1), y: cy(t) }, left];
        points = [
          ...head,
          { x: head.at(-1)!.x, y: gy },
          { x: tail[0]!.x, y: gy },
          ...tail,
        ];
      } else {
        const down = cy(t) > cy(s);
        const gatewayExit = { x: cx(s), y: down ? s.y + s.height : s.y };
        const joinEntry = { x: cx(t), y: down ? t.y : t.y + t.height };
        if (
          sg &&
          clear(gatewayExit, { x: cx(s), y: cy(t) }, ends) &&
          clear({ x: cx(s), y: cy(t) }, left, ends)
        ) {
          points = [gatewayExit, { x: cx(s), y: cy(t) }, left];
        } else if (
          tg &&
          clear(right, { x: cx(t), y: cy(s) }, ends) &&
          clear({ x: cx(t), y: cy(s) }, joinEntry, ends)
        ) {
          points = [right, { x: cx(t), y: cy(s) }, joinEntry];
        } else {
          // Turn in the channel after the source, or before the target if
          // the target's row is blocked on the way.
          const early = clear({ x: right.x, y: cy(t) }, left, ends);
          const x = channel(early ? col(f.source) : col(f.target) - 1);
          points = [right, { x, y: cy(s) }, { x, y: cy(t) }, left];
        }
      }
      edges.set(f.id, points);
    }

    // Message flows: vertical between pools, with an elbow in the gap. A
    // flow that would pass through shapes on its way to the pool border
    // steps aside into the column channel first.
    model.messageFlows.forEach((f, i) => {
      const sp = pools.get(poolOf(f.source).id)!;
      const tp = pools.get(poolOf(f.target).id)!;
      const down = tp.y > sp.y;
      const s = nodes.get(f.source);
      const t = nodes.get(f.target);
      const side = (n: Placed, out: boolean) =>
        down === out ? n.y + n.height : n.y;
      const border = (p: Bounds, out: boolean) =>
        down === out ? p.y + p.height : p.y;
      const gy =
        (down ? sp.y + sp.height : tp.y + tp.height) +
        POOL_GAP / 2 +
        ((i % 3) - 1) * 8;

      const head: Point[] = [];
      if (s) {
        const start = { x: cx(s), y: side(s, true) };
        head.push(start);
        if (!clear(start, { x: start.x, y: border(sp, true) }, [f.source])) {
          const y = start.y + (down ? STUB : -STUB);
          head.push({ x: start.x, y }, { x: channel(col(f.source)), y });
        }
      }
      const tail: Point[] = [];
      if (t) {
        const end = { x: cx(t), y: side(t, false) };
        if (!clear(end, { x: end.x, y: border(tp, false) }, [f.target])) {
          const y = end.y + (down ? -STUB : STUB);
          tail.push({ x: channel(col(f.target)), y }, { x: end.x, y });
        }
        tail.push(end);
      }
      const sx = head.at(-1)?.x ?? tail[0]!.x;
      const tx = tail[0]?.x ?? sx;
      if (!s) head.push({ x: sx, y: border(sp, true) });
      if (!t) tail.push({ x: tx, y: border(tp, false) });
      edges.set(
        f.id,
        sx === tx
          ? [...head, ...tail]
          : [...head, { x: sx, y: gy }, { x: tx, y: gy }, ...tail],
      );
    });
    return edges;
  }

  const counts = Array.from({ length: columns }, () => 0);
  route(place(counts), (c) => (counts[c]!++, 0));
  const geo = place(counts);
  const used = Array.from({ length: columns }, () => 0);
  const edges = route(
    geo,
    (c) => geo.colX[c]! + colWidth[c]! + COLUMN_GAP / 2 + used[c]!++ * TRACK,
  );
  return { nodes: geo.nodes, pools: geo.pools, lanes: geo.lanes, edges };
}
