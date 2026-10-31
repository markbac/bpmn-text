import type { FlowNode, Pool } from '@bpmn-text/core';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { nodeSize } from './sizing.js';
import type { Elk } from './types.js';

// elkjs is CommonJS: Node's ESM loader exposes the class as `default` of
// the module object, while bundlers may return the class itself.
const ElkConstructor = ELK.default ?? (ELK as unknown as typeof ELK.default);

/** A flow node that takes part in layering: boundary events do not. */
export interface LayerNode {
  node: FlowNode;
  pool: Pool;
  /** The lane ID, or the pool ID when the pool has no lanes. */
  band: string;
}

/** A sequence or message flow between layer nodes. */
export interface LayerEdge {
  id: string;
  source: string;
  target: string;
  message: boolean;
}

export interface Layering {
  /** Column of each layer node. */
  column: Map<string, number>;
  /** Position within its column, top to bottom (ELK's in-layer order). */
  order: Map<string, number>;
  columns: number;
}

/**
 * Phase 2's input order: one story order over all pools. Each pool keeps
 * its document order (with inserted joins just before the step they lead
 * to), and the pools are merged so that a message flow's target comes
 * after its source where possible. Document order breaks ties and cycles.
 */
export function storyOrder(
  nodes: LayerNode[],
  edges: LayerEdge[],
  pools: Pool[],
): LayerNode[] {
  const key = new Map<string, number>();
  const successor = new Map(
    edges.filter((e) => !e.message).map((e) => [e.source, e.target]),
  );
  for (const [pi, pool] of pools.entries()) {
    const own = nodes.filter((n) => n.pool === pool);
    const index = new Map(own.map((n, i) => [n.node.id, i]));
    const position = (n: FlowNode, depth = 0): number => {
      const next = successor.get(n.id);
      if (n.generated !== 'join' || !next || depth > own.length) {
        return index.get(n.id)!;
      }
      const target = own.find((o) => o.node.id === next)!.node;
      return position(target, depth + 1) - 0.5;
    };
    const sorted = own
      .map((n) => ({ n, at: position(n.node) }))
      .sort((a, b) => a.at - b.at);
    sorted.forEach(({ n }, i) => key.set(n.node.id, pi * 1e6 + i));
  }

  const before = new Map(nodes.map((n) => [n.node.id, new Set<string>()]));
  for (const e of edges) {
    if (e.message || key.get(e.source)! < key.get(e.target)!) {
      before.get(e.target)!.add(e.source);
    }
  }
  const byId = new Map(nodes.map((n) => [n.node.id, n]));
  const open = [...key.keys()].sort((a, b) => key.get(a)! - key.get(b)!);
  const done = new Set<string>();
  const result: LayerNode[] = [];
  while (open.length > 0) {
    const ready = open.findIndex((id) =>
      [...before.get(id)!].every((b) => done.has(b)),
    );
    // A cycle through message flows: fall back to document order.
    const [next] = open.splice(Math.max(ready, 0), 1);
    done.add(next!);
    result.push(byId.get(next!)!);
  }
  return result;
}

/**
 * Phase 2: one ELK layered graph over the flow nodes of all pools.
 * Sequence flows keep their nodes close; message flows only align columns
 * across pools. Model-order cycle breaking draws loops as back edges.
 */
export async function layer(
  nodes: LayerNode[],
  edges: LayerEdge[],
  pools: Pool[],
  elk: Elk = new ElkConstructor(),
): Promise<Layering> {
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
      'elk.spacing.nodeNode': '30',
      'elk.layered.spacing.nodeNodeBetweenLayers': '50',
    },
    children: storyOrder(nodes, edges, pools).map((n) => ({
      id: n.node.id,
      ...nodeSize(n.node.kind),
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
      layoutOptions: {
        'elk.layered.priority.shortness': e.message ? '0' : '10',
      },
    })),
  };
  const result = await elk.layout(graph);

  // ELK reports coordinates, not layer indices: nodes whose x ranges
  // overlap share a layer.
  const placed = [...(result.children ?? [])].sort(
    (a, b) => a.x! - b.x! || a.y! - b.y!,
  );
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
  return { column, order, columns: current + 1 };
}
