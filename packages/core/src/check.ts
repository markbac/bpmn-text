import { build, type BuildOptions } from './builder.js';
import type { Diagnostic } from './diagnostics.js';
import type { Model } from './model.js';
import { parse } from './parser.js';
import { validate, type ValidateOptions } from './validator.js';

export type CheckOptions = BuildOptions & ValidateOptions;

export interface CheckResult {
  model: Model;
  diagnostics: Diagnostic[];
}

/**
 * Parses, builds and validates `source`, without layout. Diagnostics are
 * sorted by position. Never throws: with errors, the model is best-effort.
 */
export function check(source: string, options: CheckOptions = {}): CheckResult {
  const parsed = parse(source);
  const built = build(parsed.ast, options);
  const diagnostics = [
    ...parsed.diagnostics,
    ...built.diagnostics,
    ...validate(built.model, options),
  ];
  diagnostics.sort((a, b) => a.range.start.offset - b.range.start.offset);
  return { model: built.model, diagnostics };
}
