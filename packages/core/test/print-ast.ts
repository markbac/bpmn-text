import type { Range } from '../src/diagnostics.js';

/**
 * A compact, readable form of an AST for snapshots: ranges become
 * `line:col-line:col`, texts become their value (quoted ones keep their
 * quotes) and empty lists are dropped.
 */
export function printAst(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(printAst);
  if (!node || typeof node !== 'object') return node;
  const o = node as Record<string, unknown>;
  if (isRange(o)) return showRange(o);
  if ('value' in o && 'quoted' in o && 'range' in o) {
    return o.quoted ? JSON.stringify(o.value) : o.value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = printAst(v);
  }
  return out;
}

const isRange = (o: object): o is Range =>
  'start' in o &&
  'end' in o &&
  typeof (o.start as { line?: unknown }).line === 'number';
const showRange = ({ start, end }: Range) =>
  `${start.line}:${start.col}-${end.line}:${end.col}`;
