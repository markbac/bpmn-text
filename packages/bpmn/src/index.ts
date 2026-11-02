import type {
  Container,
  FlowNode,
  Group,
  Lane,
  Model,
  Pool,
} from '@bpmn-text/core';
import type { LayoutResult } from '@bpmn-text/layout';
import { BpmnModdle } from 'bpmn-moddle';
import { addDiagrams } from './di.js';
import { semantic } from './semantic.js';

export {
  composeLegend,
  legend,
  type Legend,
  type LegendEntry,
  type LegendSection,
} from './legend.js';

/** An element of the BPMN model being written, as bpmn-moddle holds it. */
export type BpmnElement = Record<string, unknown>;

/** The part of bpmn-moddle an extension hook needs to make new elements. */
export interface ElementFactory {
  /** A BPMN element, such as `bpmn:ExtensionElements`. */
  create(type: string, attrs?: Record<string, unknown>): BpmnElement;
  /** A vendor element in a namespace of its own. */
  createAny(
    name: string,
    namespace: string,
    attrs?: Record<string, unknown>,
  ): BpmnElement;
}

/**
 * Called for each flow node, pool, lane and group that becomes a BPMN
 * element. `node.extra` holds the attributes the notation does not define,
 * which the hook can turn into vendor extension elements.
 */
export type ExtensionHook = (
  node: FlowNode | Pool | Lane | Group,
  element: BpmnElement,
  factory: ElementFactory,
) => void;

export interface GenerateOptions {
  extend?: ExtensionHook;
}

/**
 * Serialises `model` as BPMN 2.0 XML. With a `layout`, the output includes
 * diagram interchange (shapes, edges and labels); without, it is the
 * semantic part only.
 */
export async function generate(
  model: Model,
  layout?: LayoutResult,
  options: GenerateOptions = {},
): Promise<string> {
  const moddle = new BpmnModdle();
  const result = semantic(model, moddle);
  if (options.extend) {
    const visit = (item: FlowNode | Pool | Lane | Group) => {
      const element = result.elements.get(item.id);
      if (element) options.extend!(item, element, moddle);
    };
    const container = (c: Container) => {
      for (const n of c.nodes) {
        visit(n);
        if (n.children) container(n.children);
      }
    };
    for (const pool of model.pools) {
      visit(pool);
      pool.lanes.forEach(visit);
      if (pool.process) container(pool.process);
    }
    model.groups.forEach(visit);
  }
  if (layout) addDiagrams(model, layout, result, moddle);
  const { xml } = await moddle.toXML(result.definitions, { format: true });
  return `${xml}\n`;
}
