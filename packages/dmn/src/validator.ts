import { diagnostic, type Diagnostic } from '@bpmn-text/core';
import type { DmnModel } from './model.js';

/**
 * Checks on the built model: requirement cycles (BT512), decisions without
 * logic (BT513), and the hit-policy rules of tables (BT514 to BT516).
 */
export function validateDmn(model: DmnModel): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byId = new Map(model.elements.map((e) => [e.id, e]));

  // Cycles, through decisions and knowledge models. Each requirement that
  // closes a cycle is reported once.
  const outgoing = new Map<string, typeof model.requirements>();
  for (const r of model.requirements) {
    const list = outgoing.get(r.from) ?? [];
    list.push(r);
    outgoing.set(r.from, list);
  }
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (id: string) => {
    state.set(id, 'open');
    path.push(id);
    for (const r of outgoing.get(id) ?? []) {
      const s = state.get(r.to);
      if (s === 'open') {
        const cycle = path.slice(path.indexOf(r.to)).concat(r.to);
        diagnostics.push(
          diagnostic(
            'BT512',
            `These requirements form a cycle: ${cycle
              .reverse()
              .map((c) => `\`${byId.get(c)!.name}\``)
              .join(' requires ')}.`,
            r.range,
          ),
        );
      } else if (!s) visit(r.to);
    }
    path.pop();
    state.set(id, 'done');
  };
  for (const e of model.elements) if (!state.has(e.id)) visit(e.id);

  for (const e of model.elements) {
    if (e.kind !== 'decision') continue;
    if (!e.logic) {
      diagnostics.push(
        diagnostic(
          'BT513',
          `\`${e.name}\` has no logic. Add a \`table\` or a \`literal\` under it.`,
          e.nameRange,
        ),
      );
      continue;
    }
    if (e.logic.type !== 'table') continue;
    const t = e.logic;
    if (t.aggregation && t.outputs.length > 1) {
      diagnostics.push(
        diagnostic(
          'BT514',
          `\`collect ${t.aggregation.toLowerCase()}\` needs exactly one output column; this table has ${t.outputs.length}.`,
          t.hitRange,
        ),
      );
    }
    const names = new Map<string, (typeof t.outputs)[number]>();
    for (const o of t.outputs) {
      const first = names.get(o.name);
      if (first) {
        diagnostics.push(
          diagnostic(
            'BT515',
            `There is already an output column called \`${o.name}\`.`,
            o.range,
            { related: [{ message: 'The first one', range: first.range }] },
          ),
        );
      } else names.set(o.name, o);
    }
    if (
      (t.hitPolicy === 'PRIORITY' || t.hitPolicy === 'OUTPUT ORDER') &&
      t.outputs.some((o) => !o.values)
    ) {
      const o = t.outputs.find((x) => !x.values)!;
      diagnostics.push(
        diagnostic(
          'BT516',
          `\`${t.hitPolicy.toLowerCase()}\` orders the rules by the allowed values of the outputs, and \`${o.name}\` has none. Write them in order after \`in\`, such as \`-> ${o.name}: string in "high", "low"\`.`,
          o.range,
        ),
      );
    }
  }
  return diagnostics;
}
