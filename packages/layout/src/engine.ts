import type { Container, FlowNode, Model, Pool } from '@bpmn-text/core';
import { layer, type LayerEdge, type LayerNode } from './layering.js';
import { labelSize, nodeSize } from './sizing.js';
import type {
  Bounds,
  EdgeLayout,
  LayoutOptions,
  LayoutResult,
  Point,
  ShapeLayout,
} from './types.js';

const POOL_LABEL = 30;
const LANE_LABEL = 30;
const PAD_X = 40;
const PAD_Y = 25;
const ROW_H = 110;
/** Below the rows of a band that back edges return through. */
const GUTTER = 30;
/** Width of one edge track in a channel between columns. */
const TRACK = 12;
/** Short segment leaving a shape before turning. */
const STUB = 15;
/** Below the top of a row, clear of boundary events of the row above. */
const ROW_GAP = 9;
const POOL_GAP = 50;
const COLLAPSED_H = 60;
const LABEL_GAP = 5;

const cx = (b: Bounds) => b.x + b.width / 2;
const cy = (b: Bounds) => b.y + b.height / 2;
const isGateway = (n: FlowNode) => n.kind.endsWith('Gateway');

interface Placed extends Bounds {
  column: number;
  row: number;
  band: string;
}

interface Flow {
  id: string;
  /** The drawn source: a boundary event or a layer node. */
  source: string;
  target: string;
  /** The layer nodes at each end: a boundary event's host. */
  from: string;
  to: string;
  name?: string;
}

/**
 * Lays out the pools, lanes and top-level flow nodes of `model`
 * (architecture §6.2, phases 0 and 2 to 6 and 8). Subprocesses are drawn at
 * task size, and boundary events on their host's bottom border.
 */
export async function layout(
  model: Model,
  options: LayoutOptions = {},
): Promise<LayoutResult> {
  const columnGap = options.nodeSpacing ?? 50;

  // Phase 0: the nodes that take part, and the flows between them.
  const layerNodes: LayerNode[] = [];
  const boundaries: FlowNode[] = [];
  /** Any flow node, boundary event or pool ID → its drawn ancestor. */
  const top = new Map<string, string>();
  const nodeById = new Map<string, FlowNode>();
  const poolOf = new Map<string, Pool>();
  for (const pool of model.pools) {
    top.set(pool.id, pool.id);
    poolOf.set(pool.id, pool);
    for (const node of pool.process?.nodes ?? []) {
      nodeById.set(node.id, node);
      poolOf.set(node.id, pool);
      if (node.attachedTo) {
        boundaries.push(node);
        continue;
      }
      layerNodes.push({ node, pool, band: node.laneId ?? pool.id });
      const descend = (c: Container | undefined) => {
        for (const child of c?.nodes ?? []) {
          top.set(child.id, node.id);
          poolOf.set(child.id, pool);
          descend(child.children);
        }
      };
      top.set(node.id, node.id);
      descend(node.children);
    }
    for (const b of boundaries) top.set(b.id, b.attachedTo!);
  }
  const flows: Flow[] = model.pools
    .flatMap((p) => p.process?.flows ?? [])
    .map((f) => ({
      id: f.id,
      source: f.sourceRef,
      target: f.targetRef,
      from: top.get(f.sourceRef)!,
      to: top.get(f.targetRef)!,
      ...(f.name ? { name: f.name } : {}),
    }));
  const layerEdges: LayerEdge[] = [
    ...flows
      .filter((f) => f.from !== f.to)
      .map((f) => ({ id: f.id, source: f.from, target: f.to, message: false })),
    ...model.messageFlows
      .map((f) => ({
        id: f.id,
        source: top.get(f.sourceRef)!,
        target: top.get(f.targetRef)!,
        message: true,
      }))
      .filter((e) => nodeById.has(e.source) && nodeById.has(e.target)),
  ];

  // Phase 2: columns.
  const { column, order, columns } = await layer(
    layerNodes,
    layerEdges,
    model.pools,
    options.elk,
  );
  const col = (id: string) => column.get(top.get(id)!)!;
  const isBack = (f: Flow) => col(f.to) <= col(f.from);

  // Phase 3: rows. Within a band and column, nodes stack in ELK order, and
  // nodes reached only through boundary events go below the main path.
  const main = new Set<string>();
  const next = new Map<string, string[]>();
  for (const f of flows) {
    if (nodeById.get(f.source)?.attachedTo) continue;
    next.set(f.from, [...(next.get(f.from) ?? []), f.to]);
  }
  const queue = layerNodes
    .filter((n) => !flows.some((f) => f.to === n.node.id && f.from !== f.to))
    .map((n) => n.node.id);
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (main.has(id)) continue;
    main.add(id);
    queue.push(...(next.get(id) ?? []));
  }
  const bandOf = new Map(layerNodes.map((n) => [n.node.id, n.band]));
  const row = new Map<string, number>();
  const bandRows = new Map<string, number>();
  const cells = new Map<string, LayerNode[]>();
  for (const n of layerNodes) {
    const k = `${n.band}\n${col(n.node.id)}`;
    cells.set(k, [...(cells.get(k) ?? []), n]);
  }
  // Cells are filled column by column. A node follows its predecessor's
  // row, and branches keep the order their flows were written in, so the
  // first branch of a split stays on the split's row (the main path).
  const bandIndex = new Map(
    model.pools
      .flatMap((p) => [p.id, ...p.lanes.map((l) => l.id)])
      .map((id, i) => [id, i] as const),
  );
  const outIndex = new Map<string, number>();
  const outCount = new Map<string, number>();
  for (const f of flows) {
    const boundary = nodeById.get(f.source)?.attachedTo !== undefined;
    const i = outCount.get(f.source) ?? 0;
    outCount.set(f.source, i + 1);
    outIndex.set(f.id, (boundary ? 1000 : 0) + i);
  }
  // How many nodes each node leads to, going forward: the branch that
  // leads furthest is the happy path.
  const reach = new Map<string, Set<string>>();
  const reachOf = (id: string): Set<string> => {
    let set = reach.get(id);
    if (set) return set;
    set = new Set();
    reach.set(id, set);
    for (const f of flows) {
      if (f.from !== id || col(f.to) <= col(id)) continue;
      set.add(f.to);
      for (const r of reachOf(f.to)) set.add(r);
    }
    return set;
  };
  const sortKey = (n: LayerNode): number[] => {
    const keys = flows
      .filter((f) => f.to === n.node.id && col(f.from) < col(n.node.id))
      .map((f) => [
        bandIndex.get(bandOf.get(f.from)!)! * 1000 + row.get(f.from)!,
        outIndex.get(f.id)!,
      ])
      .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
    const rank = main.has(n.node.id) ? 0 : 1;
    const [pred, index] = keys[0] ?? [-1, 0];
    const furthest = -reachOf(n.node.id).size;
    return [rank, pred!, furthest, index!, order.get(n.node.id)!];
  };
  const byColumn = [...cells.values()].sort(
    (a, b) => col(a[0]!.node.id) - col(b[0]!.node.id),
  );
  for (const cell of byColumn) {
    const keys = new Map(cell.map((n) => [n, sortKey(n)]));
    cell.sort((a, b) => {
      const [ka, kb] = [keys.get(a)!, keys.get(b)!];
      return ka.map((v, i) => v - kb[i]!).find((d) => d !== 0) ?? 0;
    });
    let r = 0;
    for (const n of cell) {
      if (keys.get(n)![0] === 1) r = Math.max(r, 1);
      row.set(n.node.id, r++);
    }
    const band = cell[0]!.band;
    bandRows.set(band, Math.max(bandRows.get(band) ?? 1, r));
  }
  const colWidth = Array.from({ length: columns }, (_, c) =>
    Math.max(
      0,
      ...layerNodes
        .filter((n) => col(n.node.id) === c)
        .map((n) => nodeSize(n.node.kind).width),
    ),
  );
  const gutters = new Set(flows.filter(isBack).map((f) => bandOf.get(f.from)!));

  // Phase 4: coordinates, given the number of tracks in each channel.
  // Channel c runs along the left of column c; channel `columns` closes
  // the pools on the right.
  const gapOf = (c: number) => (c === 0 || c === columns ? PAD_X : columnGap);
  function place(tracks: number[]) {
    const channelX: number[] = [];
    const colX: number[] = [];
    let x = POOL_LABEL + LANE_LABEL;
    for (let c = 0; c <= columns; c++) {
      channelX.push(x);
      x += gapOf(c) + tracks[c]! * TRACK;
      colX.push(x);
      x += colWidth[c] ?? 0;
    }
    const width =
      channelX[columns]! + gapOf(columns) + tracks[columns]! * TRACK;
    const shapes = new Map<string, Placed>();
    const pools = new Map<string, Bounds>();
    const bands = new Map<string, Bounds>();
    let y = 0;
    for (const p of model.pools) {
      if (p.collapsed) {
        pools.set(p.id, { x: 0, y, width, height: COLLAPSED_H });
        y += COLLAPSED_H + POOL_GAP;
        continue;
      }
      const t = y;
      for (const band of p.lanes.length ? p.lanes.map((l) => l.id) : [p.id]) {
        const height =
          (bandRows.get(band) ?? 1) * ROW_H +
          2 * PAD_Y +
          (gutters.has(band) ? GUTTER : 0);
        bands.set(band, {
          x: POOL_LABEL,
          y,
          width: width - POOL_LABEL,
          height,
        });
        y += height;
      }
      pools.set(p.id, { x: 0, y: t, width, height: y - t });
      y += POOL_GAP;
    }
    for (const n of layerNodes) {
      const band = bands.get(n.band)!;
      const s = nodeSize(n.node.kind);
      const c = col(n.node.id);
      const r = row.get(n.node.id)!;
      shapes.set(n.node.id, {
        x: colX[c]! + (colWidth[c]! - s.width) / 2,
        y: band.y + PAD_Y + r * ROW_H + (ROW_H - s.height) / 2,
        ...s,
        column: c,
        row: r,
        band: n.band,
      });
    }
    // Phase 7 (boundary events only): spread along the host's bottom.
    const hosted = new Map<string, FlowNode[]>();
    for (const b of boundaries) {
      hosted.set(b.attachedTo!, [...(hosted.get(b.attachedTo!) ?? []), b]);
    }
    for (const [host, events] of hosted) {
      const h = shapes.get(host)!;
      const s = nodeSize('boundaryEvent');
      events.forEach((b, i) => {
        shapes.set(b.id, {
          x: h.x + (h.width * (i + 1)) / (events.length + 1) - s.width / 2,
          y: h.y + h.height - s.height / 2,
          ...s,
          column: h.column,
          row: h.row,
          band: h.band,
        });
      });
    }
    return { channelX, shapes, pools, bands };
  }

  // Phases 5 and 6: routing. Which channels an edge uses depends only on
  // columns and rows, so routing once with every track in the middle of
  // its channel counts them, and routing again on the widened geometry
  // gives the final points.
  function route(geo: ReturnType<typeof place>, final: boolean) {
    const { channelX, shapes, pools, bands } = geo;
    const used = Array.from({ length: columns + 1 }, () => 0);
    const track = (c: number) =>
      channelX[c]! + gapOf(c) / 2 + (final ? used[c]! * TRACK : 0);
    const edges = new Map<string, Point[]>();

    const clear = (points: Point[], ignore: string[]) =>
      points.slice(1).every((b, i) => {
        const a = points[i]!;
        const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
        const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
        for (const [id, n] of shapes) {
          if (ignore.includes(id)) continue;
          if (x1 < n.x + n.width && x2 > n.x && y1 < n.y + n.height && y2 > n.y)
            return false;
        }
        return true;
      });
    /** The y just below the top of row `r` of `band`. */
    const gapY = (band: string, r: number) =>
      bands.get(band)!.y + PAD_Y + r * ROW_H + ROW_GAP;

    /**
     * Takes the first candidate route that passes no shape, or the last
     * one. Candidates name the channels they use, so that only the chosen
     * route takes up tracks.
     */
    function choose(
      candidates: [Point[], number[]][],
      ignore: string[],
    ): Point[] {
      const [points, channels] =
        candidates.find(([p]) => clear(p, ignore)) ?? candidates.at(-1)!;
      for (const c of new Set(channels)) used[c]!++;
      return simplify(points);
    }

    for (const f of flows) {
      const s = shapes.get(f.source)!;
      const t = shapes.get(f.target)!;
      const sNode = nodeById.get(f.source)!;
      const tNode = nodeById.get(f.target)!;
      const boundary = sNode.attachedTo !== undefined;
      const right = { x: s.x + s.width, y: cy(s) };
      const left = { x: t.x, y: cy(t) };
      const bottom = { x: cx(s), y: s.y + s.height };
      const candidates: [Point[], number[]][] = [];
      if (isBack(f)) {
        // Back to an earlier column through the gutter of the source band.
        const gy =
          bands.get(bandOf.get(f.from)!)!.y +
          bands.get(bandOf.get(f.from)!)!.height -
          GUTTER / 2;
        const a = s.column + 1;
        const b = t.column;
        const exits: [Point[], number[]][] = [
          [[bottom, { x: bottom.x, y: gy }], []],
          [[right, { x: track(a), y: right.y }, { x: track(a), y: gy }], [a]],
        ];
        const entries: [Point[], number[]][] = [
          [
            [
              { x: cx(t), y: gy },
              { x: cx(t), y: t.y + t.height },
            ],
            [],
          ],
          [[{ x: track(b), y: gy }, { x: track(b), y: left.y }, left], [b]],
        ];
        for (const [exit, ec] of boundary ? exits.slice(0, 1) : exits) {
          for (const [entry, nc] of entries) {
            candidates.push([
              [...exit, ...entry],
              [...ec, ...nc],
            ]);
          }
        }
      } else if (boundary) {
        const host = shapes.get(f.from)!;
        const b = t.column;
        if (left.y > bottom.y) {
          candidates.push([[bottom, { x: bottom.x, y: left.y }, left], []]);
        }
        const gy = gapY(host.band, host.row + 1);
        candidates.push([
          [
            bottom,
            { x: bottom.x, y: gy },
            { x: track(b), y: gy },
            { x: track(b), y: left.y },
            left,
          ],
          [b],
        ]);
      } else {
        const a = s.column + 1;
        const b = t.column;
        const down = cy(t) > cy(s);
        if (cy(s) === cy(t)) candidates.push([[right, left], []]);
        if (isGateway(sNode) && cy(s) !== cy(t)) {
          const exit = { x: cx(s), y: down ? s.y + s.height : s.y };
          candidates.push([[exit, { x: exit.x, y: left.y }, left], []]);
        }
        if (isGateway(tNode) && cy(s) !== cy(t)) {
          const entry = { x: cx(t), y: down ? t.y : t.y + t.height };
          candidates.push([[right, { x: entry.x, y: right.y }, entry], []]);
        }
        for (const c of a === b ? [a] : [a, b]) {
          candidates.push([
            [
              right,
              { x: track(c), y: right.y },
              { x: track(c), y: left.y },
              left,
            ],
            [c],
          ]);
        }
        // Detours through the space at the top of a row: leaving a gateway
        // from its top or bottom, entering one the same way, or turning in
        // the channels next to the shapes.
        const rows = [
          gapY(s.band, s.row),
          gapY(t.band, t.row + 1),
          gapY(t.band, t.row),
          gapY(s.band, s.row + 1),
        ];
        for (const gy of rows) {
          const heads: [Point[], number[]][] = [
            [[right, { x: track(a), y: right.y }, { x: track(a), y: gy }], [a]],
          ];
          if (isGateway(sNode)) {
            const exit = { x: cx(s), y: gy < cy(s) ? s.y : s.y + s.height };
            heads.unshift([[exit, { x: exit.x, y: gy }], []]);
          }
          const tails: [Point[], number[]][] = [
            [[{ x: track(b), y: gy }, { x: track(b), y: left.y }, left], [b]],
          ];
          if (isGateway(tNode)) {
            const entry = { x: cx(t), y: gy < cy(t) ? t.y : t.y + t.height };
            tails.unshift([[{ x: entry.x, y: gy }, entry], []]);
          }
          for (const [head, hc] of heads) {
            for (const [tail, tc] of tails) {
              candidates.push([
                [...head, ...tail],
                [...hc, ...tc],
              ]);
            }
          }
        }
      }
      edges.set(f.id, choose(candidates, [f.source, f.target]));
    }

    // Message flows: vertical between pools, with an elbow in the gap. A
    // flow that would pass through shapes on its way to the pool border
    // steps aside into the channel after its column first.
    model.messageFlows.forEach((f, i) => {
      const sp = pools.get(poolOf.get(f.sourceRef)!.id)!;
      const tp = pools.get(poolOf.get(f.targetRef)!.id)!;
      const down = tp.y > sp.y;
      const s = shapes.get(top.get(f.sourceRef)!);
      const t = shapes.get(top.get(f.targetRef)!);
      const ignore = [top.get(f.sourceRef)!, top.get(f.targetRef)!];
      const side = (n: Bounds, out: boolean) =>
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
        if (!clear([start, { x: start.x, y: border(sp, true) }], ignore)) {
          const y = start.y + (down ? STUB : -STUB);
          const c = s.column + 1;
          head.push({ x: start.x, y }, { x: track(c), y });
          used[c]!++;
        }
      }
      const tail: Point[] = [];
      if (t) {
        const end = { x: cx(t), y: side(t, false) };
        if (!clear([end, { x: end.x, y: border(tp, false) }], ignore)) {
          const y = end.y + (down ? -STUB : STUB);
          const c = t.column + 1;
          tail.push({ x: track(c), y }, { x: end.x, y });
          used[c]!++;
        }
        tail.push(end);
      }
      const sx = head.at(-1)?.x ?? tail[0]?.x ?? cx(sp);
      const tx = tail[0]?.x ?? sx;
      if (!s) head.push({ x: sx, y: border(sp, true) });
      if (!t) tail.push({ x: tx, y: border(tp, false) });
      edges.set(
        f.id,
        simplify(
          sx === tx
            ? [...head, ...tail]
            : [...head, { x: sx, y: gy }, { x: tx, y: gy }, ...tail],
        ),
      );
    });
    return { edges, used };
  }

  let tracks = Array.from({ length: columns + 1 }, () => 0);
  tracks = route(place(tracks), false).used;
  let geo = place(tracks);
  let routed = route(geo, true);
  // If the widened geometry changed a choice, widen again.
  for (let i = 0; i < 3 && routed.used.some((u, c) => u > tracks[c]!); i++) {
    tracks = tracks.map((t, c) => Math.max(t, routed.used[c]!));
    geo = place(tracks);
    routed = route(geo, true);
  }

  // Phase 8: labels.
  const shapes = new Map<string, ShapeLayout>();
  const obstacles = [...geo.shapes.values()];
  if (model.collaboration) {
    for (const [id, b] of geo.pools) shapes.set(id, b);
  }
  for (const p of model.pools) {
    for (const l of p.lanes) shapes.set(l.id, geo.bands.get(l.id)!);
  }
  for (const [id, n] of geo.shapes) {
    const node = nodeById.get(id)!;
    const { x, y, width, height } = n;
    const shape: ShapeLayout = { x, y, width, height };
    const external = node.kind.endsWith('Event') || isGateway(node);
    if (external && node.name) {
      const size = labelSize(node.name);
      // Events: below. Gateways: above, unless a flow uses that side.
      const used = (side: number) =>
        [...routed.edges.values()].some((points) =>
          [points[0]!, points.at(-1)!].some(
            (p) => p.x === cx(n) && p.y === side,
          ),
        );
      const centred = Math.round(cx(n) - size.width / 2);
      const below = { x: centred, y: y + height + LABEL_GAP };
      shape.label = { ...below, ...size };
      if (isGateway(node)) {
        const options = [
          { x: centred, y: y - LABEL_GAP - size.height, side: y },
          { ...below, side: y + height },
        ];
        const free = options.find((o) => !used(o.side));
        shape.label = free
          ? { x: free.x, y: free.y, ...size }
          : {
              x: Math.round(x - LABEL_GAP - size.width),
              y: y - LABEL_GAP - size.height,
              ...size,
            };
      }
    }
    shapes.set(id, shape);
  }

  const edges = new Map<string, EdgeLayout>();
  const names = new Map<string, string | undefined>([
    ...flows.map((f) => [f.id, f.name] as const),
    ...model.messageFlows.map((f) => [f.id, f.name] as const),
  ]);
  for (const [id, waypoints] of routed.edges) {
    const edge: EdgeLayout = { waypoints };
    const name = names.get(id);
    if (name) edge.label = flowLabel(waypoints, labelSize(name), obstacles);
    edges.set(id, edge);
  }
  return { shapes, edges };
}

/**
 * Places a flow label next to the first segment: above a horizontal one,
 * right of a vertical one, or on the other side if that overlaps a shape.
 * Message flows (long vertical segments) get theirs at the midpoint.
 */
function flowLabel(
  points: Point[],
  size: { width: number; height: number },
  obstacles: Bounds[],
): Bounds {
  const [a, b] = [points[0]!, points[1]!];
  const vertical = a.x === b.x;
  const along = vertical
    ? Math.abs(b.y - a.y) > 4 * size.height
      ? (a.y + b.y) / 2 - size.height / 2
      : Math.min(a.y, b.y) + LABEL_GAP
    : 0;
  const options: Point[] = vertical
    ? [
        { x: a.x + LABEL_GAP, y: along },
        { x: a.x - LABEL_GAP - size.width, y: along },
      ]
    : [
        { x: Math.min(a.x, b.x) + LABEL_GAP, y: a.y - LABEL_GAP - size.height },
        { x: Math.min(a.x, b.x) + LABEL_GAP, y: a.y + LABEL_GAP },
      ];
  const fits = (p: Point) =>
    obstacles.every(
      (o) =>
        p.x >= o.x + o.width ||
        p.x + size.width <= o.x ||
        p.y >= o.y + o.height ||
        p.y + size.height <= o.y,
    );
  const at = options.find(fits) ?? options[0]!;
  return { x: Math.round(at.x), y: Math.round(at.y), ...size };
}

/** Drops repeated points and points in the middle of a straight run. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out.at(-1);
    if (last && last.x === p.x && last.y === p.y) continue;
    const prev = out.at(-2);
    if (
      prev &&
      last &&
      ((prev.x === last.x && last.x === p.x) ||
        (prev.y === last.y && last.y === p.y))
    ) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}
