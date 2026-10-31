import type {
  Attr,
  BoundaryStmt,
  Branch,
  Directive,
  ElementDecl,
  FlowStep,
  Ref,
  Statement,
  Text,
} from './ast.js';
import { parse } from './parser.js';

/** One output line, and the source line it came from. */
interface Line {
  indent: number;
  text: string;
  /** 1-based source line. */
  source: number;
  /** 1-based column of the construct in the source. */
  col: number;
}

const KEYWORDS = new Set([
  'start',
  'end',
  'catch',
  'throw',
  'wait',
  'task',
  'user',
  'service',
  'script',
  'send',
  'receive',
  'manual',
  'rule',
  'call',
  'sub',
  'xor',
  'and',
  'or',
  'event',
  'fork',
  'group',
  'pool',
  'lane',
  'lanes',
  'note',
  'doc',
  'data',
  'store',
  'title',
  'option',
  'on',
]);
const EVENT_TYPES = new Set([
  'message',
  'timer',
  'signal',
  'conditional',
  'error',
  'escalation',
  'compensation',
  'terminate',
  'link',
]);

/**
 * Prints `source` in canonical style (architecture §3.3): two-space
 * indentation, one space around arrows, quotes only where needed, at most
 * one blank line in a row, and every comment kept. Source with syntax
 * errors is returned unchanged, so that nothing the parser skipped is lost.
 */
export function format(source: string): string {
  const { ast, comments, diagnostics } = parse(source);
  if (diagnostics.some((d) => d.severity === 'error')) return source;

  const lines: Line[] = [];
  const items = [...ast.directives, ...ast.body].sort(
    (a, b) => a.range.start.offset - b.range.start.offset,
  );
  for (const item of items) {
    if (item.type === 'title' || item.type === 'option') directive(item, lines);
    else statement(item, 0, lines);
  }

  // Comments: trailing ones stay on their line; others go before the next
  // line, at the indentation of the neighbour they were aligned with.
  const out: Line[] = [];
  const own = comments.filter(
    (c) => !lines.some((l) => l.source === c.range.start.line),
  );
  const trailing = comments.filter((c) => !own.includes(c));
  for (const c of trailing) {
    const line = lines.filter((l) => l.source === c.range.start.line).at(-1)!;
    line.text += `  ${c.text}`;
  }
  let o = 0;
  for (const [i, line] of lines.entries()) {
    while (o < own.length && own[o]!.range.start.line < line.source) {
      const c = own[o++]!;
      const prev = lines[i - 1];
      const indent =
        prev && c.range.start.col >= prev.col && c.range.start.col > line.col
          ? prev.indent
          : line.indent;
      out.push({
        indent,
        text: c.text,
        source: c.range.start.line,
        col: c.range.start.col,
      });
    }
    out.push(line);
  }
  for (const c of own.slice(o)) {
    const prev = out.at(-1);
    const indent = prev && c.range.start.col >= prev.col ? prev.indent : 0;
    out.push({
      indent,
      text: c.text,
      source: c.range.start.line,
      col: c.range.start.col,
    });
  }

  // Keep one blank line wherever the source had any.
  const text: string[] = [];
  let last = 0;
  for (const line of out) {
    if (
      text.length &&
      line.source > last + 1 &&
      sourceBlank(source, last, line.source)
    ) {
      text.push('');
    }
    text.push(line.text ? '  '.repeat(line.indent) + line.text : '');
    last = Math.max(last, line.source);
  }
  return text.length ? `${text.join('\n')}\n` : '';
}

/** Whether any line strictly between `from` and `to` (1-based) is blank. */
function sourceBlank(source: string, from: number, to: number): boolean {
  const lines = source.split(/\r?\n/);
  for (let l = from + 1; l < to; l++) if (!lines[l - 1]?.trim()) return true;
  return false;
}

function emit(
  lines: Line[],
  indent: number,
  text: string,
  at: { start: { line: number; col: number } },
) {
  lines.push({ indent, text, source: at.start.line, col: at.start.col });
}

function directive(d: Directive, lines: Line[]) {
  const text =
    d.type === 'title'
      ? `title ${quote(d.value.value)}`
      : `option ${d.key.value} ${d.value.value}`;
  emit(lines, 0, text, d.range);
}

function statement(s: Statement, indent: number, lines: Line[]) {
  switch (s.type) {
    case 'element-stmt':
      emit(lines, indent, element(s.element) + tail(s.tail), s.range);
      for (const b of s.boundaries) boundary(b, indent + 1, lines);
      break;
    case 'gateway':
      emit(lines, indent, element(s.element), s.range);
      for (const b of s.branches ?? []) branch(b, indent + 1, lines);
      break;
    case 'fork':
      emit(lines, indent, 'fork', s.range);
      for (const b of s.branches) branch(b, indent + 1, lines);
      break;
    case 'sub': {
      emit(lines, indent, element(s.element), s.range);
      const inner = [...(s.body ?? []), ...s.boundaries].sort(
        (a, b) => a.range.start.offset - b.range.start.offset,
      );
      for (const x of inner) {
        if (x.type === 'boundary') boundary(x, indent + 1, lines);
        else statement(x, indent + 1, lines);
      }
      break;
    }
    case 'group':
    case 'pool':
      emit(
        lines,
        indent,
        `${s.type} ${name(s.name, 'element')}${attrs(s.attrs)}`,
        s.range,
      );
      for (const x of s.body ?? []) statement(x, indent + 1, lines);
      break;
    case 'lane':
      emit(
        lines,
        indent,
        `lane ${name(s.name, 'element')}${attrs(s.attrs)}`,
        s.range,
      );
      break;
    case 'lanes':
      emit(
        lines,
        indent,
        `lanes ${s.lanes.map((l) => name(l.name, 'list') + attrs(l.attrs)).join(', ')}`,
        s.range,
      );
      break;
    case 'goto':
      emit(lines, indent, tail(s.tail).trimStart(), s.range);
      break;
    case 'message':
      emit(lines, indent, reference(s.source, 'ref') + tail([s.step]), s.range);
      break;
    case 'note':
      emit(lines, indent, `note ${name(s.text, 'element')}`, s.range);
      break;
    case 'data':
      emit(
        lines,
        indent,
        `${s.kind} ${name(s.name, 'element')}${attrs(s.attrs)}`,
        s.range,
      );
      break;
    case 'doc': {
      const docLines = s.text.split('\n');
      if (docLines.length === 1 && docLines[0]) {
        emit(lines, indent, `doc ${s.text}`, s.range);
        break;
      }
      emit(lines, indent, 'doc', s.range);
      // Block lines follow the `doc` line one source line each.
      docLines.forEach((text, i) =>
        lines.push({
          indent: indent + 1,
          text,
          source: s.range.start.line + 1 + i,
          col: 0,
        }),
      );
      break;
    }
  }
}

function boundary(b: BoundaryStmt, indent: number, lines: Line[]) {
  emit(lines, indent, element(b.element) + tail(b.tail), b.range);
  for (const x of b.body) statement(x, indent + 1, lines);
}

function branch(b: Branch, indent: number, lines: Line[]) {
  const head =
    b.form === 'bullet'
      ? '-'
      : b.form === 'else'
        ? 'else:'
        : `${name(b.label!, 'label')}:`;
  const inline = b.inline
    ? ` ${b.inline.target.type === 'element' ? element(b.inline.target) : reference(b.inline.target, 'list')}${tail(b.inline.tail)}`
    : '';
  emit(lines, indent, head + inline, b.range);
  for (const x of b.body) statement(x, indent + 1, lines);
}

function element(e: ElementDecl): string {
  let text = e.keyword.value;
  if (e.eventType && e.keyword.value !== 'wait') text += ` ${e.eventType}`;
  const typed =
    e.keyword.value !== 'wait' &&
    ['start', 'end', 'catch', 'throw', 'on'].includes(e.kind);
  if (e.name) text += ` ${name(e.name, typed ? 'typed' : 'element')}`;
  if (e.id) text += ` @${e.id.value}`;
  return text + attrs(e.attrs);
}

function tail(steps: FlowStep[]): string {
  return steps
    .map((s) => {
      const arrow =
        s.op === 'sequence'
          ? s.label
            ? `-(${s.label.value})->`
            : '->'
          : s.label
            ? `~(${s.label.value})~>`
            : '~>';
      // Sequence-flow references always split at commas.
      const context = s.op === 'sequence' ? 'list' : 'ref';
      const targets = s.targets
        .map((t) => (t.type === 'element' ? element(t) : reference(t, context)))
        .join(', ');
      return ` ${arrow} ${targets}`;
    })
    .join('');
}

function reference(r: Ref, context: 'ref' | 'list'): string {
  return r.id ? `@${r.id.value}` : name(r.name!, context);
}

function attrs(list: Attr[]): string {
  if (!list.length) return '';
  const items = list.map((a) =>
    a.values.length
      ? `${a.key.value}: ${a.values.map((v) => name(v, 'attr')).join(', ')}`
      : a.key.value,
  );
  return ` [${items.join(', ')}]`;
}

type Context = 'element' | 'typed' | 'ref' | 'list' | 'label' | 'attr';

/** A name as written: bare when that reads back the same, else quoted. */
function name(t: Text, context: Context): string {
  return needsQuotes(t.value, context) ? quote(t.value) : t.value;
}

function needsQuotes(value: string, context: Context): boolean {
  if (!value || value !== value.trim() || /["\\\n]/.test(value)) return true;
  // Inside brackets only these separate tokens; `#` is not a comment there.
  if (context === 'attr') return /[,:@[\]]/.test(value);
  if (/->|-\(|~>|~\(|\)->|\)~>|@|\[|\]|(^|\s)#/.test(value)) return true;
  const first = value.split(/\s/)[0]!;
  switch (context) {
    case 'typed':
      return EVENT_TYPES.has(first);
    case 'ref':
      return KEYWORDS.has(first);
    case 'list':
      return KEYWORDS.has(first) || value.includes(',');
    case 'label':
      return (
        value === 'else' || /:(\s|$)/.test(value) || /^-(\s|$)/.test(value)
      );
    default:
      return false;
  }
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}
