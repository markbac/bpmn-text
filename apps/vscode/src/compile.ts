import { generate } from '@bpmn-text/bpmn';
import { check, sourceMap, type Range } from '@bpmn-text/core';
import { layout } from '@bpmn-text/layout';

export interface Compiled {
  xml: string;
  /** BPMN element ID → source range, for selection sync. */
  sourceMap: Record<string, Range>;
  errors: number;
}

/** The compile pipeline of the `bpmn-text` package, as the preview runs it. */
export async function compile(source: string): Promise<Compiled> {
  const { model, diagnostics } = check(source);
  return {
    xml: await generate(model, await layout(model)),
    sourceMap: sourceMap(model),
    errors: diagnostics.filter((d) => d.severity === 'error').length,
  };
}
