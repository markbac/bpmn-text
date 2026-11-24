import type { Range } from './diagnostics.js';
import type { Container, Model } from './model.js';

/**
 * Every element of `model` with an ID, mapped to its source range.
 * Associations map to the element that declared them; inserted joins to
 * the gateway (or fork, or boundary event host) whose branches they merge.
 */
export function sourceMap(model: Model): Record<string, Range> {
  const map: Record<string, Range> = {};
  const add = (e: { id: string; source: Range }) => (map[e.id] = e.source);
  const container = (c: Container) => {
    for (const n of c.nodes) {
      map[n.id] = n.cause ?? n.source;
      for (const a of [...n.reads, ...n.writes]) map[a.id] = n.source;
      if (n.children) container(n.children);
    }
    c.flows.forEach(add);
    for (const a of c.annotations) {
      add(a);
      map[a.association] = a.source;
    }
  };
  for (const p of model.pools) {
    add(p);
    p.lanes.forEach(add);
    if (p.process) {
      map[p.process.id] = p.source;
      container(p.process);
      p.process.dataObjects.forEach(add);
      p.process.dataObjectReferences.forEach(add);
      p.process.dataStoreReferences.forEach(add);
    }
  }
  model.messageFlows.forEach(add);
  model.dataStores.forEach(add);
  model.definitions.forEach(add);
  model.groups.forEach(add);
  return map;
}

/**
 * The element whose source contains `offset`, for cursor → diagram sync
 * (FR-43): the innermost one, among the elements `drawn` accepts.
 */
export function elementAt(
  sourceMap: Record<string, Range>,
  offset: number,
  drawn: (id: string) => boolean = () => true,
): string | undefined {
  let best: string | undefined;
  let size = Infinity;
  for (const [id, r] of Object.entries(sourceMap)) {
    if (offset < r.start.offset || offset > r.end.offset || !drawn(id))
      continue;
    const span = r.end.offset - r.start.offset;
    // Ties: shapes before the flows and associations declared with them.
    if (span < size || (span === size && isFlow(best) && !isFlow(id))) {
      best = id;
      size = span;
    }
  }
  return best;
}

const isFlow = (id: string | undefined) =>
  !!id &&
  /^(Flow|MessageFlow|Association|Data(Input|Output)Association)_/.test(id);
