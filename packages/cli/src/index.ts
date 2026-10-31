import { generate } from '@bpmn-text/bpmn';
import {
  check,
  sourceMap,
  type CheckOptions,
  type Diagnostic,
  type Model,
  type Range,
} from '@bpmn-text/core';
import {
  layout as layOut,
  type LayoutOptions,
  type LayoutResult,
} from '@bpmn-text/layout';

export { check, format, parse, sourceMap } from '@bpmn-text/core';
export type {
  CheckOptions,
  CheckResult,
  Diagnostic,
  Model,
  ParseResult,
  Range,
} from '@bpmn-text/core';
export type { LayoutOptions, LayoutResult } from '@bpmn-text/layout';

export interface CompileOptions extends CheckOptions {
  /** Layout settings, such as `{ nodeSpacing: 60 }`. */
  layout?: LayoutOptions;
}

export interface CompileResult {
  /** BPMN 2.0 XML with diagram interchange. */
  xml: string;
  model: Model;
  layout: LayoutResult;
  /** Sorted by position. With errors, `xml` shows a best-effort model. */
  diagnostics: Diagnostic[];
  /** BPMN element ID → the source range it was written at. */
  sourceMap: Record<string, Range>;
}

/**
 * Compiles bpmn-text source into laid-out BPMN 2.0 XML. Never rejects on
 * errors in the source: they are reported in `diagnostics`, and the
 * output shows what could be built.
 *
 * ```ts
 * const { xml, diagnostics } = await compile(source, {
 *   layout: { nodeSpacing: 60 },
 * });
 * ```
 */
export async function compile(
  source: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const { model, diagnostics } = check(source, options);
  const layout = await layOut(model, options.layout);
  const xml = await generate(model, layout);
  return { xml, model, layout, diagnostics, sourceMap: sourceMap(model) };
}
