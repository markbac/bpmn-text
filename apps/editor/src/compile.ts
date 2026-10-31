import { generate } from '@bpmn-text/bpmn';
import {
  check,
  sourceMap,
  type Container,
  type Diagnostic,
  type Range,
} from '@bpmn-text/core';
import { layout } from '@bpmn-text/layout';

export interface Compiled {
  xml: string;
  diagnostics: Diagnostic[];
  /** BPMN element ID → source range, for selection sync. */
  sourceMap: Record<string, Range>;
  /** BPMN element ID → documentation, for tooltips. */
  documentation: Record<string, string>;
  /** Element and pool names, for completion after `->` and `~>`. */
  names: string[];
  /** Lane names, for completion after `lane`. */
  lanes: string[];
  /** How long the compile took, in milliseconds. */
  ms: number;
}

/**
 * The compile pipeline of the `bpmn-text` package, plus what the editor
 * needs for completion and tooltips. Never throws: an internal error comes
 * back as a diagnostic.
 */
export async function compileSource(source: string): Promise<Compiled> {
  const started = performance.now();
  const { model, diagnostics } = check(source);
  const names = new Set<string>();
  const lanes = new Set<string>();
  const documentation: Record<string, string> = {};
  const walk = (c: Container) => {
    for (const n of c.nodes) {
      if (n.name) names.add(n.name);
      if (n.documentation) documentation[n.id] = n.documentation;
      if (n.children) walk(n.children);
    }
  };
  for (const p of model.pools) {
    if (!p.implicit) names.add(p.name);
    if (p.documentation) documentation[p.id] = p.documentation;
    for (const l of p.lanes) {
      lanes.add(l.name);
      if (l.documentation) documentation[l.id] = l.documentation;
    }
    if (p.process) walk(p.process);
  }
  for (const g of model.groups) {
    if (g.documentation) documentation[g.id] = g.documentation;
  }
  let xml = '';
  try {
    xml = await generate(model, await layout(model));
  } catch (error) {
    diagnostics.push({
      code: 'BT001',
      severity: 'error',
      message: `Internal error while drawing the diagram: ${String(error)}`,
      range: {
        start: { line: 1, col: 1, offset: 0 },
        end: { line: 1, col: 1, offset: 0 },
      },
    });
  }
  return {
    xml,
    diagnostics,
    sourceMap: sourceMap(model),
    documentation,
    names: [...names],
    lanes: [...lanes],
    ms: Math.round(performance.now() - started),
  };
}
