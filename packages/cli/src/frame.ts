import type { Diagnostic, Severity } from '@bpmn-text/core';

const codes = {
  bold: [1, 22],
  red: [31, 39],
  yellow: [33, 39],
  cyan: [36, 39],
  blue: [34, 39],
} as const;
type Style = keyof typeof codes;

export type Paint = (style: Style, text: string) => string;

/** ANSI colours, or none. */
export const paint =
  (color: boolean): Paint =>
  (style, text) =>
    color ? `\x1b[${codes[style][0]}m${text}\x1b[${codes[style][1]}m` : text;

const tone: Record<Severity, Style> = {
  error: 'red',
  warning: 'yellow',
  info: 'cyan',
};

/**
 * One diagnostic as a code frame:
 *
 *     error[BT202]: Unknown reference "Chek order".
 *       --> order.bpmnt:8:8
 *        |
 *      8 |     -> Chek order
 *        |        ^^^^^^^^^^
 *        = help: Replace with "Check order"
 */
export function codeFrame(
  d: Diagnostic,
  source: string,
  file: string,
  p: Paint,
): string {
  const { start, end } = d.range;
  const raw = source.split(/\r?\n/)[start.line - 1] ?? '';
  // Tabs are shown as two spaces, so the caret stays under its text.
  const shown = (text: string) => text.replace(/\t/g, '  ');
  const line = shown(raw);
  const from = shown(raw.slice(0, start.col - 1)).length;
  const to =
    end.line === start.line
      ? shown(raw.slice(0, end.col - 1)).length
      : line.length;
  const number = String(start.line);
  const gutter = ' '.repeat(number.length);
  const bar = p('blue', '|');
  const out = [
    `${p('bold', p(tone[d.severity], `${d.severity}[${d.code}]`))}${p('bold', `: ${d.message}`)}`,
    `${gutter}${p('blue', '-->')} ${file}:${start.line}:${start.col}`,
    `${gutter} ${bar}`,
    `${p('blue', number)} ${bar} ${line}`,
    `${gutter} ${bar} ${' '.repeat(from)}${p(tone[d.severity], '^'.repeat(Math.max(1, to - from)))}`,
  ];
  for (const r of d.related ?? []) {
    out.push(
      `${gutter} ${p('blue', '=')} note: ${r.message} (${file}:${r.range.start.line}:${r.range.start.col})`,
    );
  }
  for (const fix of d.fixes ?? []) {
    out.push(`${gutter} ${p('blue', '=')} help: ${fix.title}`);
  }
  return `${out.join('\n')}\n`;
}

/** `order.bpmnt: 1 error, 2 warnings`, or `order.bpmnt: ok`. */
export function summary(
  file: string,
  diagnostics: Diagnostic[],
  p: Paint,
): string {
  const count = (severity: Severity, one: string, many: string) => {
    const n = diagnostics.filter((d) => d.severity === severity).length;
    return n ? [p(tone[severity], `${n} ${n === 1 ? one : many}`)] : [];
  };
  const parts = [
    ...count('error', 'error', 'errors'),
    ...count('warning', 'warning', 'warnings'),
    ...count('info', 'info', 'info'),
  ];
  return `${file}: ${parts.length ? parts.join(', ') : 'ok'}\n`;
}
