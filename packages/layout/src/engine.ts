import type {
  Container,
  FlowNode,
  Model,
  Pool,
  Process,
} from '@bpmn-text/core';
import { layer, type LayerEdge, type LayerNode } from './layering.js';
import {
  annotationSize,
  dataSize,
  labelSize,
  nodeSize,
  type Size,
} from './sizing.js';
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
/** Space above and below the tallest shape of a row. */
const ROW_PAD = 15;
/** Below the rows of a band that back edges return through. */
const GUTTER = 30;
/** Width of one edge track in a channel between columns. */
const TRACK = 12;
/** Short segment leaving a shape before turning. */
const STUB = 15;
/** Below the top of a row, clear of boundary events of the row above. */
const ROW_GAP = 9;
/** Height of one edge track in the gap at the top of a row. */
const GAP_TRACK = 10;
const POOL_GAP = 50;
const COLLAPSED_H = 60;
const LABEL_GAP = 5;
/** Expanded subprocess: padding around its body, and room for its name. */
const SUB_PAD = 20;
const SUB_TOP = 30;
/** Space between a row and its attachments (annotations, data). */
const ATTACH_GAP = 15;
/** Space between data shapes side by side. */
const DATA_GAP = 10;
const ANNOTATION_WIDTH = 100;
/** Space between a group border and the shapes and labels inside. */
const GROUP_PAD = 10;

const cx = (b: Bounds) => b.x + b.width / 2;
const even = (n: number) => 2 * Math.ceil(n / 2);
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

/** A data reference or annotation drawn next to its anchor (phase 7). */
interface Attachment {
  id: string;
  kind: 'data' | 'annotation';
  size: Size;
  anchor: string;
  label?: string;
  text?: string;
}

/** An association line, from `source` to `target` as in the semantics. */
interface Association {
  id: string;
  source: string;
  target: string;
  /** Which end is the data reference or annotation. */
  attachment: 'source' | 'target';
}

interface Laid {
  result: LayoutResult;
  /** Shapes and edges on other diagram planes (collapsed subprocesses). */
  offPlane: Set<string>;
}

/**
 * Lays out `model` (architecture §6.2): pools, lanes, flow nodes, expanded
 * subprocesses with their bodies, boundary events, data, annotations and
 * groups. Collapsed subprocesses get task size; their bodies are laid out
 * on planes of their own.
 */
export async function layout(
  model: Model,
  options: LayoutOptions = {},
): Promise<LayoutResult> {
  return (await layoutModel(model, options)).result;
}

/** A subprocess body as a model of its own: one pool without lanes. */
function bodyModel(model: Model, sub: FlowNode, process: Process): Model {
  const nested = new Set<string>();
  const descend = (c: Container) => {
    for (const n of c.nodes) {
      if (!n.children) continue;
      nested.add(n.id);
      descend(n.children);
    }
  };
  descend(sub.children!);
  // Inside the body, its own data references are the top-level ones, and
  // those of nested subprocesses stay theirs.
  const mine = <T extends { container?: string }>(list: T[]) =>
    list
      .filter((d) => d.container === sub.id || nested.has(d.container ?? ''))
      .map((d) => {
        if (d.container !== sub.id) return d;
        const copy = { ...d };
        delete copy.container;
        return copy;
      });
  return {
    xorJoin: model.xorJoin,
    collaboration: false,
    pools: [
      {
        id: `${sub.id}__body`,
        name: '',
        collapsed: false,
        implicit: true,
        lanes: [],
        extra: {},
        source: sub.source,
        process: {
          id: `${sub.id}__process`,
          ...sub.children!,
          dataObjects: mine(process.dataObjects),
          dataStoreReferences: mine(process.dataStoreReferences),
        },
      },
    ],
    messageFlows: [],
    dataStores: model.dataStores,
    groups: [],
  };
}

/** The box around every shape, label and edge point of `r`. */
function extent(r: LayoutResult): Bounds {
  const boxes: Bounds[] = [];
  for (const s of r.shapes.values()) {
    boxes.push(s);
    if (s.label) boxes.push(s.label);
  }
  for (const e of r.edges.values()) {
    for (const p of e.waypoints) boxes.push({ ...p, width: 0, height: 0 });
    if (e.label) boxes.push(e.label);
  }
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}

function translate(r: LayoutResult, dx: number, dy: number): LayoutResult {
  const move = <T extends Point>(p: T): T => ({
    ...p,
    x: p.x + dx,
    y: p.y + dy,
  });
  return {
    shapes: new Map(
      [...r.shapes].map(([id, s]) => [
        id,
        { ...move(s), ...(s.label ? { label: move(s.label) } : {}) },
      ]),
    ),
    edges: new Map(
      [...r.edges].map(([id, e]) => [
        id,
        {
          waypoints: e.waypoints.map(move),
          ...(e.label ? { label: move(e.label) } : {}),
        },
      ]),
    ),
  };
}

async function layoutModel(
  model: Model,
  options: LayoutOptions,
): Promise<Laid> {
  const columnGap = options.nodeSpacing ?? 50;

  // Phase 1: subprocess bodies, bottom-up. An expanded subprocess takes the
  // size of its body; a collapsed one keeps task size, and its body goes
  // on a plane of its own.
  const sizes = new Map<string, Size>();
  const bodies = new Map<string, { laid: Laid; box: Bounds }>();
  const offPlane = new Set<string>();
  const extra: LayoutResult = { shapes: new Map(), edges: new Map() };
  for (const pool of model.pools) {
    for (const node of pool.process?.nodes ?? []) {
      if (!node.children?.nodes.length) continue;
      const laid = await layoutModel(
        bodyModel(model, node, pool.process!),
        options,
      );
      if (node.collapsed) {
        for (const [id, s] of laid.result.shapes) extra.shapes.set(id, s);
        for (const [id, e] of laid.result.edges) extra.edges.set(id, e);
        for (const id of [
          ...laid.result.shapes.keys(),
          ...laid.result.edges.keys(),
          ...laid.offPlane,
        ])
          offPlane.add(id);
        continue;
      }
      const onPlane: LayoutResult = {
        shapes: new Map(
          [...laid.result.shapes].filter(([id]) => !laid.offPlane.has(id)),
        ),
        edges: new Map(
          [...laid.result.edges].filter(([id]) => !laid.offPlane.has(id)),
        ),
      };
      const box = extent(onPlane);
      bodies.set(node.id, { laid, box });
      // Even sizes keep centres on whole pixels.
      sizes.set(node.id, {
        width: Math.max(100, even(box.width + 2 * SUB_PAD)),
        height: Math.max(80, even(box.height + SUB_TOP + SUB_PAD)),
      });
    }
  }
  const sizeOf = (n: FlowNode): Size => sizes.get(n.id) ?? nodeSize(n.kind);

  // Phase 0: the nodes that take part, and the flows between them.
  const layerNodes: LayerNode[] = [];
  const boundaries: FlowNode[] = [];
  /** Any flow node, boundary event or pool ID → its drawn ancestor. */
  const top = new Map<string, string>();
  const nodeById = new Map<string, FlowNode>();
  const poolOf = new Map<string, Pool>();
  // Groups: partitions in document order, with ungrouped runs between them.
  const groupIndex = new Map(model.groups.map((g, i) => [g.id, i]));
  const grouped = model.groups.length > 0;
  for (const pool of model.pools) {
    top.set(pool.id, pool.id);
    poolOf.set(pool.id, pool);
    let lastGroup = -1;
    for (const node of pool.process?.nodes ?? []) {
      nodeById.set(node.id, node);
      poolOf.set(node.id, pool);
      if (node.attachedTo) {
        boundaries.push(node);
        continue;
      }
      const g = node.groupId ? groupIndex.get(node.groupId)! : undefined;
      if (g !== undefined) lastGroup = g;
      layerNodes.push({
        node,
        pool,
        band: node.laneId ?? pool.id,
        size: sizeOf(node),
        ...(grouped
          ? { partition: g !== undefined ? 2 * g + 1 : 2 * lastGroup + 2 }
          : {}),
      });
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

  // Phase 7 input: data references next to the activity that first uses
  // them, annotations above their element.
  const attachments: Attachment[] = [];
  const associations: Association[] = [];
  for (const pool of model.pools) {
    const p = pool.process;
    if (!p) continue;
    const users = (ref: string) =>
      p.nodes.find((n) =>
        [...n.reads, ...n.writes].some((a) => a.dataRef === ref),
      );
    const data = [
      ...p.dataObjects.map(
        (o) => [o.reference, o.name, false, o.container] as const,
      ),
      ...p.dataStoreReferences.map(
        (r) =>
          [
            r.id,
            model.dataStores.find((s) => s.id === r.store)?.name,
            true,
            r.container,
          ] as const,
      ),
    ];
    for (const [id, name, store, container] of data) {
      if (container !== undefined) continue;
      const anchor = users(id) ?? p.nodes.find((n) => !n.attachedTo);
      if (!anchor) continue;
      attachments.push({
        id,
        kind: 'data',
        size: dataSize(store),
        anchor: top.get(anchor.id)!,
        ...(name ? { label: name } : {}),
      });
    }
    for (const a of p.annotations) {
      attachments.push({
        id: a.id,
        kind: 'annotation',
        size: { width: 0, height: 0 },
        anchor: top.get(a.attachedTo)!,
        text: a.text,
      });
      associations.push({
        id: a.association,
        source: a.attachedTo,
        target: a.id,
        attachment: 'target',
      });
    }
    const dataAssociations = (c: Container) => {
      for (const n of c.nodes) {
        for (const a of n.reads) {
          associations.push({
            id: a.id,
            source: a.dataRef,
            target: n.id,
            attachment: 'source',
          });
        }
        for (const a of n.writes) {
          associations.push({
            id: a.id,
            source: n.id,
            target: a.dataRef,
            attachment: 'target',
          });
        }
        if (n.children) dataAssociations(n.children);
      }
    };
    dataAssociations(p);
  }
  const attachedTo = new Map<string, Attachment[]>();
  for (const a of attachments) {
    attachedTo.set(a.anchor, [...(attachedTo.get(a.anchor) ?? []), a]);
  }

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
  const hosted = new Map<string, FlowNode[]>();
  for (const b of boundaries) {
    hosted.set(b.attachedTo!, [...(hosted.get(b.attachedTo!) ?? []), b]);
  }

  // Phase 7, sizes first: data side by side below their anchor, clear of
  // its boundary events; annotations as wide as their column.
  const colWidth = Array.from({ length: columns }, (_, c) =>
    Math.max(
      0,
      ...layerNodes
        .filter((n) => col(n.node.id) === c)
        .map((n) => n.size.width),
    ),
  );
  /** Data shapes' centres, relative to their anchor's centre. */
  const dataOffset = new Map<string, number>();
  // Data with users besides its anchor go last (right), towards those
  // users, which usually come later.
  const userCount = new Map<string, number>();
  for (const a of associations) {
    for (const end of [a.source, a.target])
      userCount.set(end, (userCount.get(end) ?? 0) + 1);
  }
  for (const [anchor, list] of attachedTo) {
    const data = list
      .filter((a) => a.kind === 'data')
      .sort(
        (a, b) =>
          Number((userCount.get(a.id) ?? 0) > 1) -
          Number((userCount.get(b.id) ?? 0) > 1),
      );
    if (!data.length) continue;
    const width = nodeById.get(anchor)
      ? sizeOf(nodeById.get(anchor)!).width
      : 0;
    const events = hosted.get(anchor)?.length ?? 0;
    let centres: number[];
    if (events > 0 && data.length <= events + 1) {
      // Between the boundary events, nearest the middle first.
      centres = Array.from(
        { length: events + 1 },
        (_, i) => (width * (i + 0.5)) / (events + 1) - width / 2,
      )
        .sort((a, b) => Math.abs(a) - Math.abs(b) || a - b)
        .slice(0, data.length)
        .sort((a, b) => a - b);
    } else {
      // Side by side, each as wide as its label too.
      const slot = (d: Attachment) =>
        Math.max(d.size.width, d.label ? labelSize(d.label).width : 0);
      const total =
        data.reduce((s, d) => s + slot(d), 0) + DATA_GAP * (data.length - 1);
      let x = -total / 2;
      centres = data.map((d) => {
        const c = x + slot(d) / 2;
        x += slot(d) + DATA_GAP;
        return c;
      });
    }
    data.forEach((d, i) => dataOffset.set(d.id, centres[i]!));
    const c = col(anchor);
    const half = Math.max(
      ...data.map((d) => Math.abs(dataOffset.get(d.id)!) + d.size.width / 2),
    );
    colWidth[c] = Math.max(colWidth[c]!, even(2 * half));
  }
  for (const a of attachments) {
    if (a.kind !== 'annotation') continue;
    const c = col(a.anchor);
    colWidth[c] = Math.max(colWidth[c]!, ANNOTATION_WIDTH);
  }
  for (const a of attachments) {
    if (a.kind === 'annotation')
      a.size = annotationSize(a.text!, colWidth[col(a.anchor)]!);
  }

  // Row heights: the tallest shape of each row, and the attachment strips
  // above (annotations) and below (data) it.
  const rowKey = (band: string, r: number) => `${band}\n${r}`;
  const rowHeight = new Map<string, number>();
  const above = new Map<string, number>();
  const below = new Map<string, number>();
  for (const n of layerNodes) {
    const k = rowKey(n.band, row.get(n.node.id)!);
    rowHeight.set(
      k,
      Math.max(rowHeight.get(k) ?? ROW_H, n.size.height + 2 * ROW_PAD),
    );
  }
  for (const a of attachments) {
    const k = rowKey(bandOf.get(a.anchor)!, row.get(a.anchor)!);
    if (a.kind === 'annotation') {
      above.set(k, Math.max(above.get(k) ?? 0, a.size.height + ATTACH_GAP));
    } else {
      const label = a.label ? labelSize(a.label).height + LABEL_GAP : 0;
      below.set(
        k,
        Math.max(
          below.get(k) ?? 0,
          ATTACH_GAP + a.size.height + label + ATTACH_GAP,
        ),
      );
    }
  }
  /**
   * Top of each main row of a band, from the band's top. Above a row, from
   * the top: its annotations, then room for the edge tracks its gap needs
   * beyond the first (`gapTracks`, by row key).
   */
  let rowTops = new Map<string, number[]>();
  function stackRows(gapTracks: Map<string, number>) {
    rowTops = new Map();
    for (const [band, count] of bandRows) {
      const tops: number[] = [];
      let y = PAD_Y;
      for (let r = 0; r <= count; r++) {
        const k = rowKey(band, r);
        y += (above.get(k) ?? 0) + extraGap(gapTracks, k);
        tops.push(y);
        y += (rowHeight.get(k) ?? ROW_H) + (below.get(k) ?? 0);
      }
      rowTops.set(band, tops);
    }
  }
  /** The gutter of a band, where back edges return, has tracks too. */
  const gutterKey = (band: string) => `${band}\ngutter`;
  const extraGap = (gapTracks: Map<string, number>, k: string) =>
    Math.max(0, (gapTracks.get(k) ?? 0) - 1) * GAP_TRACK;
  const rowTop = (band: string, r: number) =>
    rowTops.get(band)?.[Math.min(r, bandRows.get(band) ?? 1)] ??
    PAD_Y + r * ROW_H;
  const rowH = (band: string, r: number) =>
    rowHeight.get(rowKey(band, r)) ?? ROW_H;
  const gutters = new Set(flows.filter(isBack).map((f) => bandOf.get(f.from)!));

  // Groups: the columns each one spans, and the label overhang next to
  // them, which their borders must clear.
  const groupColumns = new Map<string, [number, number]>();
  for (const g of model.groups) {
    const cs = g.members
      .filter((id) => column.has(id))
      .map((id) => column.get(id)!);
    if (cs.length) groupColumns.set(g.id, [Math.min(...cs), Math.max(...cs)]);
  }
  const overhang = Array.from({ length: columns }, (_, c) => {
    const widths = [
      ...layerNodes
        .filter((n) => col(n.node.id) === c && n.node.name)
        .filter((n) => n.node.kind.endsWith('Event') || isGateway(n.node))
        .map((n) => labelSize(n.node.name!).width),
      ...attachments
        .filter((a) => a.label && col(a.anchor) === c)
        .map((a) => labelSize(a.label!).width),
    ];
    return Math.max(0, ...widths.map((w) => (w - colWidth[c]!) / 2));
  });
  const groupEdge = new Set(
    [...groupColumns.values()].flatMap(([a, b]) => [a, b + 1]),
  );

  // Phase 4: coordinates, given the number of tracks in each channel.
  // Channel c runs along the left of column c; channel `columns` closes
  // the pools on the right.
  const gapOf = (c: number) => {
    const base = c === 0 || c === columns ? PAD_X : columnGap;
    if (!groupEdge.has(c)) return base;
    const side = Math.max(overhang[c - 1] ?? 0, overhang[c] ?? 0);
    return Math.max(base, Math.ceil(2 * (side + GROUP_PAD) + 2 * GROUP_PAD));
  };
  function place(tracks: number[], gapTracks: Map<string, number>) {
    stackRows(gapTracks);
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
          rowTop(band, bandRows.get(band) ?? 1) +
          PAD_Y +
          (gutters.has(band)
            ? GUTTER + extraGap(gapTracks, gutterKey(band))
            : 0);
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
      const s = n.size;
      const c = col(n.node.id);
      const r = row.get(n.node.id)!;
      shapes.set(n.node.id, {
        x: Math.round(colX[c]! + (colWidth[c]! - s.width) / 2),
        y: Math.round(
          band.y + rowTop(n.band, r) + (rowH(n.band, r) - s.height) / 2,
        ),
        ...s,
        column: c,
        row: r,
        band: n.band,
      });
    }
    // Phase 7: boundary events spread along the host's bottom.
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
    // Annotations above their anchor's row, as wide as its column; data
    // below it.
    const attached = new Map<string, Bounds>();
    for (const a of attachments) {
      const h = shapes.get(a.anchor)!;
      const band = bands.get(h.band)!;
      const top = band.y + rowTop(h.band, h.row);
      attached.set(
        a.id,
        a.kind === 'annotation'
          ? {
              x: colX[h.column]!,
              y: top - ATTACH_GAP - a.size.height,
              ...a.size,
            }
          : {
              x: Math.round(cx(h) + dataOffset.get(a.id)! - a.size.width / 2),
              y: top + rowH(h.band, h.row) + ATTACH_GAP,
              ...a.size,
            },
      );
    }
    return { channelX, colX, shapes, attached, pools, bands, gapTracks };
  }

  // Phases 5 and 6: routing. Which channels an edge uses depends only on
  // columns and rows, so routing once with every track in the middle of
  // its channel counts them, and routing again on the widened geometry
  // gives the final points.
  function route(geo: ReturnType<typeof place>, final: boolean) {
    const { channelX, shapes, attached, pools, bands, gapTracks } = geo;
    const used = Array.from({ length: columns + 1 }, () => 0);
    /** Edge tracks taken in the gap at the top of each row, by row key. */
    const usedGap = new Map<string, number>();
    const track = (c: number) =>
      channelX[c]! + gapOf(c) / 2 + (final ? used[c]! * TRACK : 0);
    const edges = new Map<string, Point[]>();
    const obstacles = [...shapes, ...attached];

    const clear = (points: Point[], ignore: string[]) =>
      points.slice(1).every((b, i) => {
        const a = points[i]!;
        const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
        const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
        for (const [id, n] of obstacles) {
          if (ignore.includes(id)) continue;
          if (x1 < n.x + n.width && x2 > n.x && y1 < n.y + n.height && y2 > n.y)
            return false;
        }
        return true;
      });
    /**
     * The y of the next free track in the gap at the top of row `r` of
     * `band`: below the row's top, clear of boundary events of the row
     * above, one track further down for each detour already there.
     */
    const gapY = (band: string, r: number) => {
      const k = rowKey(band, Math.min(r, bandRows.get(band) ?? 1));
      const index = final ? (usedGap.get(k) ?? 0) : 0;
      return (
        bands.get(band)!.y +
        rowTop(band, r) -
        extraGap(gapTracks, k) +
        ROW_GAP +
        index * GAP_TRACK
      );
    };
    /** The gap a detour at `y` runs through, if any. */
    const gapAt = new Map<number, string>();
    const gap = (band: string, r: number) => {
      const y = gapY(band, r);
      gapAt.set(y, rowKey(band, Math.min(r, bandRows.get(band) ?? 1)));
      return y;
    };

    /** Routes taken so far, by source and target, to keep repeats apart. */
    const taken = new Map<string, string[]>();
    /**
     * Takes the first candidate route that passes no shape and is not
     * another flow's route between the same two shapes, or failing that
     * the first that passes no shape, or the last one. Candidates name the
     * channels they use, and their row gaps are found from their points,
     * so that only the chosen route takes up tracks.
     */
    function choose(
      candidates: [Point[], number[]][],
      ignore: string[],
      source: string,
      target: string,
    ): Point[] {
      const pair = `${source}\n${target}`;
      const repeats = taken.get(pair) ?? [];
      const [points, channels] =
        candidates.find(
          ([p]) =>
            clear(p, ignore) && !repeats.includes(JSON.stringify(simplify(p))),
        ) ??
        candidates.find(([p]) => clear(p, ignore)) ??
        candidates.at(-1)!;
      for (const c of new Set(channels)) used[c]!++;
      const route = simplify(points);
      // A horizontal segment on a gap track takes that track.
      const gaps = new Set<string>();
      for (const [i, b] of route.slice(1).entries()) {
        const a = route[i]!;
        const k = a.y === b.y ? gapAt.get(a.y) : undefined;
        if (k) gaps.add(k);
      }
      for (const k of gaps) usedGap.set(k, (usedGap.get(k) ?? 0) + 1);
      taken.set(pair, [...repeats, JSON.stringify(route)]);
      return route;
    }
    /**
     * Whether a node may leave from its top or bottom towards a branch
     * above or below: gateways, and activities that fan out (#62) and
     * have no boundary events on their bottom border.
     */
    const splits = (n: FlowNode) =>
      isGateway(n) || ((outCount.get(n.id) ?? 0) > 1 && !hosted.has(n.id));

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
        // Back to an earlier column through the gutter of the source band,
        // on the next free track.
        const band = bandOf.get(f.from)!;
        const k = gutterKey(band);
        const gy =
          bands.get(band)!.y +
          bands.get(band)!.height -
          GUTTER / 2 -
          extraGap(gapTracks, k) +
          (final ? (usedGap.get(k) ?? 0) : 0) * GAP_TRACK;
        gapAt.set(gy, k);
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
        const gy = gap(host.band, host.row + 1);
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
        if (splits(sNode) && cy(s) !== cy(t)) {
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
          gap(s.band, s.row),
          gap(t.band, t.row + 1),
          gap(t.band, t.row),
          gap(s.band, s.row + 1),
        ];
        for (const gy of rows) {
          const heads: [Point[], number[]][] = [
            [[right, { x: track(a), y: right.y }, { x: track(a), y: gy }], [a]],
          ];
          if (splits(sNode)) {
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
      edges.set(
        f.id,
        choose(candidates, [f.source, f.target], f.source, f.target),
      );
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
    return { edges, used, usedGap };
  }

  let tracks = Array.from({ length: columns + 1 }, () => 0);
  let gapTracks = new Map<string, number>();
  const first = route(place(tracks, gapTracks), false);
  tracks = first.used;
  gapTracks = first.usedGap;
  let geo = place(tracks, gapTracks);
  let routed = route(geo, true);
  // If the widened geometry changed a choice, widen again.
  const wider = () =>
    routed.used.some((u, c) => u > tracks[c]!) ||
    [...routed.usedGap].some(([k, n]) => n > (gapTracks.get(k) ?? 0));
  for (let i = 0; i < 3 && wider(); i++) {
    tracks = tracks.map((t, c) => Math.max(t, routed.used[c]!));
    gapTracks = new Map(
      [...new Set([...gapTracks.keys(), ...routed.usedGap.keys()])].map((k) => [
        k,
        Math.max(gapTracks.get(k) ?? 0, routed.usedGap.get(k) ?? 0),
      ]),
    );
    geo = place(tracks, gapTracks);
    routed = route(geo, true);
  }

  // Phase 1, placed: subprocess bodies move into their shapes.
  const inner: LayoutResult = { shapes: new Map(), edges: new Map() };
  for (const [id, { laid, box }] of bodies) {
    const s = geo.shapes.get(id)!;
    const moved = translate(
      laid.result,
      s.x + SUB_PAD - box.x + (s.width - 2 * SUB_PAD - box.width) / 2,
      s.y + SUB_TOP - box.y,
    );
    for (const [i, shape] of moved.shapes) {
      inner.shapes.set(
        i,
        laid.offPlane.has(i) ? laid.result.shapes.get(i)! : shape,
      );
    }
    for (const [i, edge] of moved.edges) {
      inner.edges.set(
        i,
        laid.offPlane.has(i) ? laid.result.edges.get(i)! : edge,
      );
    }
    for (const i of laid.offPlane) offPlane.add(i);
  }

  // Phase 8: labels.
  const shapes = new Map<string, ShapeLayout>();
  const obstacles = [...geo.shapes.values(), ...geo.attached.values()];
  if (model.collaboration) {
    for (const [id, b] of geo.pools) shapes.set(id, b);
  }
  for (const p of model.pools) {
    for (const l of p.lanes) shapes.set(l.id, geo.bands.get(l.id)!);
  }

  // Associations (phase 7): from the planes' shapes, around the others.
  const onPlane = new Map<string, Bounds>([
    ...geo.shapes,
    ...geo.attached,
    ...[...inner.shapes].filter(([id]) => !offPlane.has(id)),
  ]);
  const associationEdges = new Map<string, Point[]>();
  for (const a of associations) {
    if (inner.edges.has(a.id)) continue;
    const s = onPlane.get(a.source);
    const t = onPlane.get(a.target);
    if (!s || !t) continue;
    const ignore = new Set([a.source, a.target]);
    for (const [id, b] of onPlane) {
      if (contains(b, s) || contains(b, t)) ignore.add(id);
    }
    // Routed from the attachment, so that the flow node is entered from
    // its top or bottom rather than where sequence flows are.
    const points =
      a.attachment === 'source'
        ? associate(s, t, onPlane, ignore)
        : associate(t, s, onPlane, ignore).reverse();
    associationEdges.set(a.id, points);
  }
  const ends = [...routed.edges.values(), ...associationEdges.values()].flatMap(
    (points) => [points[0]!, points.at(-1)!],
  );

  /** Whether a flow or association passes through `box`. */
  const routes = [...routed.edges.values(), ...associationEdges.values()];
  const crossed = (box: Bounds) =>
    routes.some((points) =>
      points.slice(1).some((b, i) => {
        const a = points[i]!;
        return (
          Math.min(a.x, b.x) < box.x + box.width &&
          Math.max(a.x, b.x) > box.x &&
          Math.min(a.y, b.y) < box.y + box.height &&
          Math.max(a.y, b.y) > box.y
        );
      }),
    );
  for (const [id, n] of geo.shapes) {
    const node = nodeById.get(id)!;
    const { x, y, width, height } = n;
    const shape: ShapeLayout = { x, y, width, height };
    const external = node.kind.endsWith('Event') || isGateway(node);
    if (external && node.name) {
      const size = labelSize(node.name);
      // Events: below. Gateways: above, unless a flow uses that side.
      const used = (side: number) =>
        ends.some((p) => p.x === cx(n) && p.y === side);
      const centred = Math.round(cx(n) - size.width / 2);
      const below = { x: centred, y: y + height + LABEL_GAP };
      shape.label = { ...below, ...size };
      // A boundary event's flow leaves from its bottom: label to the right.
      if (node.attachedTo && (outCount.get(id) ?? 0) > 0) {
        shape.label = { x: Math.round(cx(n) + LABEL_GAP), y: below.y, ...size };
      }
      if (isGateway(node)) {
        const options = [
          { x: centred, y: y - LABEL_GAP - size.height, side: y },
          { ...below, side: y + height },
        ];
        const free = options.find((o) => !used(o.side));
        // Both sides taken: beside the top corner, left or right, where
        // that clears the shapes.
        const corners = [
          {
            x: Math.round(x - LABEL_GAP - size.width),
            y: y - LABEL_GAP - size.height,
          },
          {
            x: Math.round(x + width + LABEL_GAP),
            y: y - LABEL_GAP - size.height,
          },
        ];
        const clearOf = (p: Point) =>
          obstacles.every(
            (o) =>
              p.x >= o.x + o.width ||
              p.x + size.width <= o.x ||
              p.y >= o.y + o.height ||
              p.y + size.height <= o.y,
          );
        const corner = corners.find(clearOf) ?? corners[0]!;
        // The first place, in that order, that no flow passes through:
        // above, below, beside each corner, then higher above, clear of
        // the flows leaving the top.
        const unused = options.filter((o) => !used(o.side));
        const lowCorners = corners.map((c) => ({
          x: c.x,
          y: y + height + LABEL_GAP,
        }));
        const higher = [1, 2, 3, 4].map((k) => ({
          x: centred,
          y: y - LABEL_GAP - size.height - k * GAP_TRACK,
        }));
        const readable = [...unused, ...corners, ...lowCorners, ...higher].find(
          (p) => clearOf(p) && !crossed({ ...p, ...size }),
        );
        shape.label = readable
          ? { x: readable.x, y: readable.y, ...size }
          : free
            ? { x: free.x, y: free.y, ...size }
            : { ...corner, ...size };
      }
    }
    shapes.set(id, shape);
  }
  for (const a of attachments) {
    const b = geo.attached.get(a.id)!;
    const shape: ShapeLayout = { ...b };
    if (a.label) {
      const size = labelSize(a.label);
      shape.label = {
        x: Math.round(cx(b) - size.width / 2),
        y: b.y + b.height + LABEL_GAP,
        ...size,
      };
    }
    shapes.set(a.id, shape);
  }

  // Phase 9: group boxes over their columns, the full height of their
  // pools, or with `[fit]` around their members.
  for (const g of model.groups) {
    const range = groupColumns.get(g.id);
    if (!range) continue;
    const [a, b] = range;
    const members = g.members.flatMap((id) => {
      const s = shapes.get(id);
      return s ? [s, ...(s.label ? [s.label] : [])] : [];
    });
    for (const [anchor, list] of attachedTo) {
      if (!g.members.includes(anchor)) continue;
      for (const at of list) {
        const s = shapes.get(at.id)!;
        members.push(s, ...(s.label ? [s.label] : []));
      }
    }
    const label = labelSize(g.name);
    let box: Bounds;
    if (g.fit) {
      const x1 = Math.min(...members.map((m) => m.x)) - GROUP_PAD;
      const y1 =
        Math.min(...members.map((m) => m.y)) - GROUP_PAD - label.height;
      const x2 = Math.max(...members.map((m) => m.x + m.width)) + GROUP_PAD;
      const y2 = Math.max(...members.map((m) => m.y + m.height)) + GROUP_PAD;
      box = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    } else {
      const pools = model.pools
        .filter((p) =>
          g.members.some((id) => poolOf.get(id) === p && column.has(id)),
        )
        .map((p) => geo.pools.get(p.id)!);
      const x1 = geo.colX[a]! - overhang[a]! - GROUP_PAD;
      const x2 = geo.colX[b]! + colWidth[b]! + overhang[b]! + GROUP_PAD;
      const y1 = Math.min(...pools.map((p) => p.y)) + LABEL_GAP;
      const y2 = Math.max(...pools.map((p) => p.y + p.height)) - LABEL_GAP;
      box = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }
    box = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
    shapes.set(g.id, {
      ...box,
      label: {
        x: Math.round(cx(box) - label.width / 2),
        y: box.y + LABEL_GAP,
        ...label,
      },
    });
  }

  const edges = new Map<string, EdgeLayout>();
  const names = new Map<string, string | undefined>([
    ...flows.map((f) => [f.id, f.name] as const),
    ...model.messageFlows.map((f) => [f.id, f.name] as const),
  ]);
  // Flow labels keep clear of each other and of event and gateway labels.
  const labels: Bounds[] = [...shapes.values()].flatMap((s) =>
    s.label ? [s.label] : [],
  );
  for (const [id, waypoints] of routed.edges) {
    const edge: EdgeLayout = { waypoints };
    const name = names.get(id);
    if (name) {
      edge.label = flowLabel(waypoints, labelSize(name), obstacles, labels);
      labels.push(edge.label);
    }
    edges.set(id, edge);
  }
  for (const [id, waypoints] of associationEdges) edges.set(id, { waypoints });

  for (const [id, s] of inner.shapes) shapes.set(id, s);
  for (const [id, e] of inner.edges) edges.set(id, e);
  for (const [id, s] of extra.shapes) shapes.set(id, s);
  for (const [id, e] of extra.edges) edges.set(id, e);
  return { result: { shapes, edges }, offPlane };
}

const contains = (outer: Bounds, b: Bounds) =>
  outer !== b &&
  b.x >= outer.x &&
  b.y >= outer.y &&
  b.x + b.width <= outer.x + outer.width &&
  b.y + b.height <= outer.y + outer.height;

/**
 * An association line from the attachment `s` to the element `t`:
 * straight up or down where they share some width, else an L or a Z around
 * the shapes in between, entering `t` from its side only as a last resort.
 */
function associate(
  s: Bounds,
  t: Bounds,
  shapes: Map<string, Bounds>,
  ignore: Set<string>,
): Point[] {
  const clear = (points: Point[]) =>
    points.slice(1).every((b, i) => {
      const a = points[i]!;
      const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
      for (const [id, n] of shapes) {
        if (ignore.has(id)) continue;
        if (x1 < n.x + n.width && x2 > n.x && y1 < n.y + n.height && y2 > n.y)
          return false;
      }
      return true;
    });
  const down = cy(t) > cy(s);
  const sV = { x: cx(s), y: down ? s.y + s.height : s.y };
  const tV = { x: cx(t), y: down ? t.y : t.y + t.height };
  const candidates: Point[][] = [];
  const x1 = Math.max(s.x, t.x);
  const x2 = Math.min(s.x + s.width, t.x + t.width);
  if (x1 < x2) {
    const within = (x: number) => x >= x1 && x <= x2;
    const x = within(cx(s)) ? cx(s) : within(cx(t)) ? cx(t) : (x1 + x2) / 2;
    candidates.push([
      { x, y: sV.y },
      { x, y: tV.y },
    ]);
  }
  const rightward = cx(t) > cx(s);
  const sH = { x: rightward ? s.x + s.width : s.x, y: cy(s) };
  const tH = { x: rightward ? t.x : t.x + t.width, y: cy(t) };
  candidates.push([sH, { x: tV.x, y: sH.y }, tV]);
  // Z shapes turning midway, next to the target, or next to the source.
  const step = down ? ATTACH_GAP : -ATTACH_GAP;
  for (const y of [(sV.y + tV.y) / 2, tV.y - step, sV.y + step]) {
    candidates.push([sV, { x: sV.x, y }, { x: tV.x, y }, tV]);
  }
  // Sides last: that is where sequence flows enter and leave.
  candidates.push([sV, { x: sV.x, y: tH.y }, tH]);
  // Around the far side of the source (below its label), for a target
  // beyond its neighbours.
  const away = down ? s.y - ATTACH_GAP : s.y + s.height + 2 * ATTACH_GAP + 10;
  const sAway = { x: cx(s), y: down ? s.y : s.y + s.height };
  candidates.splice(-1, 0, [
    sAway,
    { x: sAway.x, y: away },
    { x: tV.x, y: away },
    tV,
  ]);
  return simplify(candidates.find(clear) ?? candidates.at(-1)!).map((p) => ({
    x: Math.round(p.x),
    y: Math.round(p.y),
  }));
}

/**
 * Places a flow label next to the first segment: above a horizontal one,
 * right of a vertical one, or on the other side if that overlaps a shape.
 * Message flows (long vertical segments) get theirs at the midpoint. If
 * both sides are taken, for example by the labels of other flows leaving
 * the same point, the label goes on the last segment instead.
 */
function flowLabel(
  points: Point[],
  size: { width: number; height: number },
  obstacles: Bounds[],
  labels: Bounds[],
): Bounds {
  const beside = (a: Point, b: Point): Point[] => {
    const vertical = a.x === b.x;
    const along = vertical
      ? Math.abs(b.y - a.y) > 4 * size.height
        ? (a.y + b.y) / 2 - size.height / 2
        : Math.min(a.y, b.y) + LABEL_GAP
      : 0;
    return vertical
      ? [
          { x: a.x + LABEL_GAP, y: along },
          { x: a.x - LABEL_GAP - size.width, y: along },
        ]
      : [
          {
            x: Math.min(a.x, b.x) + LABEL_GAP,
            y: a.y - LABEL_GAP - size.height,
          },
          { x: Math.min(a.x, b.x) + LABEL_GAP, y: a.y + LABEL_GAP },
        ];
  };
  const first = beside(points[0]!, points[1]!);
  const last = points.length > 2 ? beside(points.at(-2)!, points.at(-1)!) : [];
  const free = (p: Point, list: Bounds[]) =>
    list.every(
      (o) =>
        p.x >= o.x + o.width ||
        p.x + size.width <= o.x ||
        p.y >= o.y + o.height ||
        p.y + size.height <= o.y,
    );
  const at =
    [...first, ...last].find((p) => free(p, obstacles) && free(p, labels)) ??
    first.find((p) => free(p, obstacles)) ??
    first[0]!;
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
