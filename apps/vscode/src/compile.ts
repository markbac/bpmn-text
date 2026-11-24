import { generate } from '@bpmn-text/bpmn';
import { check, sourceMap, type Range } from '@bpmn-text/core';
import { layout } from '@bpmn-text/layout';

export interface Compiled {
  /** The BPMN XML, unless it was not wanted (see `CompileOptions`). */
  xml: string | undefined;
  /** BPMN element ID → source range, for selection sync. */
  sourceMap: Record<string, Range>;
  errors: number;
}

export interface CompileOptions {
  /**
   * `always` (the default) lays out and generates the XML even when the
   * text has errors; `without-errors` skips them then, which is most of
   * the time a compile takes.
   */
  draw?: 'always' | 'without-errors';
}

/** The compile pipeline of the `bpmn-text` package, as the preview runs it. */
export async function compile(
  source: string,
  options: CompileOptions = {},
): Promise<Compiled> {
  const { model, diagnostics } = check(source);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const skip = errors > 0 && options.draw === 'without-errors';
  return {
    xml: skip ? undefined : await generate(model, await layout(model)),
    sourceMap: sourceMap(model),
    errors,
  };
}
