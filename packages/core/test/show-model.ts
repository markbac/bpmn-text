import type { Container, Model } from '../src/model.js';

/**
 * The flow structure of a model as text, one line each: pools with their
 * nodes (and lanes, boundary hosts), sequence flows (with labels and
 * defaults, nested under their subprocess) and message flows.
 */
export function showFlows(model: Model): string {
  const out: string[] = [];
  const flows = (c: Container, indent: string) => {
    for (const f of c.flows) {
      const label = f.name ? ` [${f.name}]` : '';
      out.push(
        `${indent}${f.sourceRef} -> ${f.targetRef}${label}${f.isDefault ? ' (default)' : ''}`,
      );
    }
    for (const n of c.nodes) {
      if (!n.children?.nodes.length) continue;
      out.push(`${indent}${n.id}:`);
      flows(n.children, `${indent}  `);
    }
  };
  for (const p of model.pools) {
    out.push(
      `pool ${p.id}${p.implicit ? ' (implicit)' : ''}${p.collapsed ? ' (collapsed)' : ''}`,
    );
    if (!p.process) continue;
    for (const n of p.process.nodes) {
      const where = [
        n.laneId && `in ${n.laneId}`,
        n.attachedTo && `on ${n.attachedTo}`,
      ].filter(Boolean);
      out.push(`  node ${n.id}${where.length ? ` ${where.join(' ')}` : ''}`);
    }
    flows(p.process, '  ');
  }
  for (const f of model.messageFlows) {
    out.push(
      `message ${f.sourceRef} ~> ${f.targetRef}${f.name ? ` [${f.name}]` : ''}`,
    );
  }
  return `${out.join('\n')}\n`;
}
