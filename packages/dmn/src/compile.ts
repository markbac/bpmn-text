import type { Diagnostic, Range } from '@bpmn-text/core';
import { checkDmn, dmnSourceMap, type DmnCheckOptions } from './check.js';
import { generateDmn } from './generate.js';
import { layoutDrd, type DrdLayout, type DrdLayoutOptions } from './layout.js';
import type { DmnModel } from './model.js';

export interface DmnCompileOptions extends DmnCheckOptions {
  layout?: DrdLayoutOptions;
}

export interface DmnCompileResult {
  /** DMN 1.3 XML with DMNDI. */
  xml: string;
  model: DmnModel;
  layout: DrdLayout;
  /** Sorted by position. With errors, `xml` shows a best-effort model. */
  diagnostics: Diagnostic[];
  /** DMN element ID → the source range it was written at. */
  sourceMap: Record<string, Range>;
}

/**
 * Compiles `.dmnt` source into laid-out DMN 1.3 XML. Never rejects on
 * errors in the source: they are reported in `diagnostics`, and the output
 * shows what could be built.
 */
export async function compileDmn(
  source: string,
  options: DmnCompileOptions = {},
): Promise<DmnCompileResult> {
  const { model, diagnostics } = checkDmn(source, options);
  const layout = await layoutDrd(model, options.layout);
  const xml = await generateDmn(model, layout);
  return { xml, model, layout, diagnostics, sourceMap: dmnSourceMap(model) };
}
