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
      for (const o of p.process.dataObjects) {
        add(o);
        map[o.reference] = o.source;
      }
      p.process.dataStoreReferences.forEach(add);
    }
  }
  model.messageFlows.forEach(add);
  model.dataStores.forEach(add);
  model.groups.forEach(add);
  return map;
}
