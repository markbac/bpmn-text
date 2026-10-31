import type { Model } from '@bpmn-text/core';
import type { LayoutResult } from '@bpmn-text/layout';
import { BpmnModdle } from 'bpmn-moddle';
import { addDiagrams } from './di.js';
import { semantic } from './semantic.js';

/**
 * Serialises `model` as BPMN 2.0 XML. With a `layout`, the output includes
 * diagram interchange (shapes, edges and labels); without, it is the
 * semantic part only.
 */
export async function generate(
  model: Model,
  layout?: LayoutResult,
): Promise<string> {
  const moddle = new BpmnModdle();
  const result = semantic(model, moddle);
  if (layout) addDiagrams(model, layout, result, moddle);
  const { xml } = await moddle.toXML(result.definitions, { format: true });
  return `${xml}\n`;
}
