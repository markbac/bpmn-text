import type { Comment, Text } from '@bpmn-text/core';
import type { DmnAttr, ElementStmt, Row, TableStmt } from './ast.js';
import { HIT_POLICIES, parseDmn } from './parser.js';

const INDENT = '  ';

/**
 * Rewrites `.dmnt` source in canonical style: two-space indentation,
 * attributes as `[key: value, …]`, hit policies by their long names, one
 * blank line between elements, and table columns aligned. Comments are
 * kept. Source with syntax errors is returned unchanged.
 */
export function formatDmn(source: string): string {
  const { ast, comments, diagnostics } = parseDmn(source);
  if (
    diagnostics.some((d) => d.severity === 'error' && /^BT00\d$/.test(d.code))
  )
    return source;

  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  /** Comments not yet written, in source order. */
  const pending = [...comments];
  /** A trailing comment on `line`, if any. */
  const trailing = (line: number) => {
    const i = pending.findIndex(
      (c) =>
        c.range.start.line === line &&
        lines[line - 1]!.slice(0, c.range.start.col - 1).trim() !== '',
    );
    return i === -1 ? '' : `  ${pending.splice(i, 1)[0]!.text}`;
  };
  /** Whole-line comments before `line`, at `depth`. */
  const commentsBefore = (line: number, depth: number) => {
    while (pending.length && pending[0]!.range.start.line < line) {
      const c = pending.shift()!;
      const own =
        lines[c.range.start.line - 1]!.slice(
          0,
          c.range.start.col - 1,
        ).trim() === '';
      if (!own) continue;
      if (depth === 0 || out.at(-1) !== '') blankBefore(c);
      out.push(`${INDENT.repeat(depth)}${c.text}`);
    }
  };
  /** Keeps one blank line where the source had at least one. */
  const blankBefore = (c: Comment | { range: { start: { line: number } } }) => {
    const previous = lines[c.range.start.line - 2];
    if (out.length && previous !== undefined && previous.trim() === '')
      if (out.at(-1) !== '') out.push('');
  };

  if (ast.title) {
    commentsBefore(ast.title.range.start.line, 0);
    out.push(`title ${text(ast.title)}${trailing(ast.title.range.start.line)}`);
  }
  ast.elements.forEach((e, i) => {
    const previous = ast.elements[i - 1];
    // Elements with a body are set apart; one-line elements stay together
    // unless the author separated them.
    const firstLine = Math.min(
      e.range.start.line,
      ...pending
        .filter(
          (c) =>
            c.range.start.line < e.range.start.line &&
            (!previous || c.range.start.line > previous.range.end.line),
        )
        .map((c) => c.range.start.line),
    );
    if (
      out.length > 0 &&
      out.at(-1) !== '' &&
      (hasBody(e) ||
        (previous && hasBody(previous)) ||
        lines[firstLine - 2]?.trim() === '')
    )
      out.push('');
    commentsBefore(e.range.start.line, 0);
    out.push(element(e) + trailing(e.range.start.line));
    const body = [...e.docs, ...e.logic].sort(
      (a, b) => a.range.start.offset - b.range.start.offset,
    );
    for (const node of body) {
      commentsBefore(node.range.start.line, 1);
      if (node.type === 'table') {
        out.push(
          `${INDENT}table${attrs(node.attrs)}${trailing(node.range.start.line)}`,
        );
        const rows = node.header ? [node.header, ...node.rows] : [];
        table(node).forEach((row, k) => {
          const line = rows[k]!.range.start.line;
          commentsBefore(line, 2);
          out.push(`${INDENT.repeat(2)}${row}${trailing(line)}`);
        });
        continue;
      }
      const keyword = node.type === 'doc' ? 'doc' : 'literal';
      const textLines = node.text.split('\n');
      if (textLines.length === 1) {
        out.push(`${INDENT}${keyword} ${textLines[0]}`);
        continue;
      }
      out.push(`${INDENT}${keyword}`);
      for (const l of textLines)
        out.push(l === '' ? '' : `${INDENT.repeat(2)}${l}`);
    }
  });
  for (const c of pending) {
    blankBefore(c);
    out.push(c.text);
  }
  while (out.at(-1) === '') out.pop();
  return `${out.join('\n')}\n`;
}

const hasBody = (e: ElementStmt) => e.docs.length > 0 || e.logic.length > 0;

function text(t: Text): string {
  return t.quoted ? JSON.stringify(t.value) : t.value;
}

function attrs(list: DmnAttr[]): string {
  if (!list.length) return '';
  return ` [${list
    .map((a) => {
      if (a.key.value === 'hit') {
        const written = a.values.map((v) => v.value).join(', ');
        const policy = HIT_POLICIES[written];
        return `hit: ${policy ? policy.canonical : written}`;
      }
      return `${a.key.value}: ${a.values.map(text).join(', ')}`;
    })
    .join(', ')}]`;
}

function element(e: ElementStmt): string {
  return `${e.kind} ${text(e.name)}${e.id ? ` @${e.id.value}` : ''}${attrs(e.attrs)}`;
}

/** The table's rows, with aligned columns. */
function table(t: TableStmt): string[] {
  if (!t.header) return [];
  const rows: Row[] = [t.header, ...t.rows];
  const cells = rows.map((r, i) =>
    r.cells.map((c, j) => {
      if (i === 0) {
        const column = t.columns[j];
        if (column?.marker) {
          const rest = c.raw.slice(2).trim();
          return rest ? `${column.marker} ${rest}` : column.marker;
        }
        return c.raw;
      }
      // An empty input cell means `-`.
      if (!c.raw && t.columns[j]?.role === 'input') return '-';
      return c.raw;
    }),
  );
  const widths: number[] = [];
  for (const r of cells)
    r.forEach((c, j) => (widths[j] = Math.max(widths[j] ?? 0, width(c))));
  return cells.map((r) => {
    const padded = r.map((c, j) => c + ' '.repeat(widths[j]! - width(c)));
    return `| ${padded.join(' | ')} |`;
  });
}

/** Characters as displayed, counting a surrogate pair as one. */
const width = (s: string) => [...s].length;
