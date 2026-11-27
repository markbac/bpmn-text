import type { Diagnostic, DiagnosticCode, Range } from '@bpmn-text/core';
import { buildDmn } from './builder.js';
import { checkTables } from './checks.js';
import { analyseFeel } from './feel.js';
import type { DmnModel } from './model.js';
import { parseDmn } from './parser.js';
import { validateDmn } from './validator.js';

export interface DmnCheckOptions {
  /** Turns checks off by code, such as `{ BT531: false }`. */
  rules?: Partial<Record<DiagnosticCode, boolean>>;
}

export interface DmnCheckResult {
  model: DmnModel;
  diagnostics: Diagnostic[];
}

/**
 * Parses, builds and checks `.dmnt` source, without layout: the model
 * checks, FEEL and the table checks. Diagnostics are sorted by position.
 * Never throws: with errors, the model is best-effort.
 */
export function checkDmn(
  source: string,
  options: DmnCheckOptions = {},
): DmnCheckResult {
  const parsed = parseDmn(source);
  const built = buildDmn(parsed.ast);
  const feel = analyseFeel(built.model);
  const diagnostics = [
    ...parsed.diagnostics,
    ...built.diagnostics,
    ...validateDmn(built.model),
    ...feel.diagnostics,
    ...checkTables(built.model, feel.entries),
  ].filter((d) => options.rules?.[d.code] !== false);
  diagnostics.sort(
    (a, b) =>
      a.range.start.offset - b.range.start.offset ||
      a.code.localeCompare(b.code),
  );
  return { model: built.model, diagnostics };
}

/**
 * Every element of `model` with an ID, mapped to its source range: DRD
 * elements, requirements, tables, columns, rules and cells.
 */
export function dmnSourceMap(model: DmnModel): Record<string, Range> {
  const map: Record<string, Range> = {};
  for (const e of model.elements) {
    map[e.id] = e.range;
    if (e.kind !== 'decision' && e.kind !== 'knowledge') continue;
    const logic = e.logic;
    if (!logic) continue;
    map[logic.id] = logic.range;
    if (logic.type !== 'table') continue;
    for (const i of logic.inputs) {
      map[i.id] = i.range;
      map[i.expressionId] = i.expressionRange;
    }
    for (const o of logic.outputs) map[o.id] = o.range;
    for (const r of logic.rules) {
      map[r.id] = r.range;
      for (const c of [...r.inputEntries, ...r.outputEntries])
        map[c.id] = c.range;
    }
  }
  for (const r of model.requirements) map[r.id] = r.range;
  return map;
}
