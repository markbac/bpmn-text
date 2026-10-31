import type { Diagnostic } from '@bpmn-text/core';
import type { Diagnostic as CmDiagnostic } from '@codemirror/lint';

/**
 * Compiler diagnostics as CodeMirror lint diagnostics (FR-41), with quick
 * fixes as actions. An empty range covers one character, so that it shows.
 */
export function toLint(
  diagnostics: Diagnostic[],
  length: number,
): CmDiagnostic[] {
  return diagnostics.map((d) => {
    const from = Math.min(d.range.start.offset, length);
    let to = Math.min(d.range.end.offset, length);
    if (to <= from) to = Math.min(from + 1, length);
    return {
      from,
      to,
      severity: d.severity,
      source: d.code,
      message: d.message,
      actions: (d.fixes ?? []).map((fix) => ({
        name: fix.title,
        apply(view) {
          view.dispatch({
            changes: fix.edits.map((e) => ({
              from: e.range.start.offset,
              to: e.range.end.offset,
              insert: e.newText,
            })),
          });
        },
      })),
    };
  });
}
