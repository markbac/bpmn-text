import {
  diagnostic,
  type Diagnostic,
  type Position,
  type Range,
} from './diagnostics.js';

/**
 * - `text`: a bare text run, trimmed. The parser splits it into keywords and
 *   names (notation §2).
 * - `string`: a quoted string; `value` has its escapes decoded.
 * - `id`: `@name`; `value` is the name without the `@`.
 * - `op`: an operator; `value` is its symbol.
 * - `raw`: a line of `doc` text, which is never tokenized further.
 */
export type TokenKind =
  | 'text'
  | 'string'
  | 'id'
  | 'op'
  | 'raw'
  | 'newline'
  | 'indent'
  | 'dedent'
  | 'eof';

export interface Token {
  kind: TokenKind;
  value: string;
  range: Range;
}

export interface Comment {
  /** The comment, including its `#`. */
  text: string;
  range: Range;
}

export interface LexResult {
  tokens: Token[];
  /** Comments in source order, kept for the formatter. */
  comments: Comment[];
  diagnostics: Diagnostic[];
}

const ID = /^[A-Za-z_][A-Za-z0-9_-]*/;
const isSpace = (c: string | undefined) => c === ' ' || c === '\t';

/**
 * Splits source text into tokens. Never throws: problems are reported as
 * diagnostics (BT002, BT003, BT004) and lexing continues.
 */
export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  const diagnostics: Diagnostic[] = [];
  const stack = [0];
  let doc: { indent: number; blanks: Range[] } | undefined;
  let lineStart = 0;
  let lineNo = 0;
  let end: Position = { line: 1, col: 1, offset: 0 };

  while (lineStart <= source.length) {
    lineNo++;
    const newline = source.indexOf('\n', lineStart);
    const next = newline === -1 ? source.length + 1 : newline + 1;
    let text = source.slice(
      lineStart,
      newline === -1 ? source.length : newline,
    );
    if (text.endsWith('\r')) text = text.slice(0, -1);
    const base = lineStart;
    const line = lineNo;
    const at = (i: number): Position => ({
      line,
      col: i + 1,
      offset: base + i,
    });
    const span = (from: number, to: number): Range => ({
      start: at(from),
      end: at(to),
    });
    const push = (kind: TokenKind, value: string, from: number, to: number) =>
      tokens.push({ kind, value, range: span(from, to) });
    end = at(text.length);
    lineStart = next;

    // Indentation. A tab is reported and then counts as two spaces.
    let width = 0;
    let first = 0;
    for (; isSpace(text[first]); first++) width += text[first] === '\t' ? 2 : 1;
    const blank = first === text.length;

    if (doc) {
      if (blank) {
        doc.blanks.push(span(0, 0));
        continue;
      }
      if (width > doc.indent) {
        for (const r of doc.blanks)
          tokens.push({ kind: 'raw', value: '', range: r });
        doc.blanks = [];
        push('raw', text.slice(first).trimEnd(), first, text.trimEnd().length);
        continue;
      }
      doc = undefined;
    }

    for (let i = 0; i < first; i++) {
      if (text[i] === '\t') {
        diagnostics.push(
          diagnostic(
            'BT002',
            'Use spaces for indentation, not tabs.',
            span(i, i + 1),
            {
              fixes: [
                {
                  title: 'Replace the tab with two spaces',
                  edits: [{ range: span(i, i + 1), newText: '  ' }],
                },
              ],
            },
          ),
        );
      }
    }
    if (blank) continue;
    if (text[first] === '#') {
      comments.push({
        text: text.slice(first).trimEnd(),
        range: span(first, text.trimEnd().length),
      });
      continue;
    }

    const top = stack.at(-1)!;
    if (width > top) {
      stack.push(width);
      push('indent', '', first, first);
    } else if (width < top) {
      // Close blocks down to the one this line belongs to. A line that
      // matches no open level belongs to the deepest block whose header is
      // less indented than the line.
      const i = stack.findIndex((level) => level > width);
      const target = stack[i - 1] === width ? i - 1 : i;
      if (target === i) {
        diagnostics.push(
          diagnostic(
            'BT003',
            'This line is indented less than the block it is in, but more than the enclosing block.',
            span(first, first),
          ),
        );
      }
      while (stack.length - 1 > target) {
        stack.pop();
        push('dedent', '', first, first);
      }
    }

    // `doc` takes the rest of the line, or the indented block below it, as
    // raw text (notation §4.6).
    if (/^doc(?=$|[ \t])/.test(text.slice(first))) {
      push('text', 'doc', first, first + 3);
      const rest = text.slice(first + 3);
      const from = first + 3 + (rest.length - rest.trimStart().length);
      if (rest.trim()) push('raw', rest.trim(), from, text.trimEnd().length);
      else doc = { indent: width, blanks: [] };
      push('newline', '', text.length, text.length);
      continue;
    }

    tokenizeLine(text, first, push, comments, diagnostics, span);
    push('newline', '', text.length, text.length);
  }

  while (stack.length > 1) {
    stack.pop();
    tokens.push({ kind: 'dedent', value: '', range: { start: end, end } });
  }
  tokens.push({ kind: 'eof', value: '', range: { start: end, end } });
  return { tokens, comments, diagnostics };
}

const OPERATORS = [')->', ')~>', '->', '-(', '~>', '~('] as const;

function tokenizeLine(
  text: string,
  start: number,
  push: (kind: TokenKind, value: string, from: number, to: number) => void,
  comments: Comment[],
  diagnostics: Diagnostic[],
  span: (from: number, to: number) => Range,
) {
  let depth = 0; // inside an attribute list
  let i = start;
  const colonEnds = (j: number) =>
    text[j] === ':' && (j + 1 === text.length || isSpace(text[j + 1]));
  const opAt = (j: number) => OPERATORS.find((op) => text.startsWith(op, j));
  const terminates = (j: number) => {
    const c = text[j];
    if (c === '"' || c === ',' || c === '[' || c === ']') return true;
    if (depth > 0) return c === ':';
    return (
      c === '@' ||
      colonEnds(j) ||
      opAt(j) !== undefined ||
      (c === '#' && isSpace(text[j - 1]))
    );
  };

  while (i < text.length) {
    while (isSpace(text[i])) i++;
    if (i >= text.length) break;
    const c = text[i]!;

    if (c === '#' && depth === 0) {
      comments.push({
        text: text.slice(i).trimEnd(),
        range: span(i, text.trimEnd().length),
      });
      break;
    }
    if (c === '"') {
      i = lexString(text, i, push, diagnostics, span);
      continue;
    }
    if (c === '@') {
      const id = ID.exec(text.slice(i + 1));
      if (id) {
        push('id', id[0], i, i + 1 + id[0].length);
        i += 1 + id[0].length;
      } else {
        push('op', '@', i, i + 1);
        i++;
      }
      continue;
    }
    const op = depth === 0 ? opAt(i) : undefined;
    if (op) {
      push('op', op, i, i + op.length);
      i += op.length;
      if (op === '-(' || op === '~(') {
        // A flow label runs to its closing operator.
        const close = op === '-(' ? ')->' : ')~>';
        const j = text.indexOf(close, i);
        const stop = j === -1 ? text.length : j;
        const label = text.slice(i, stop);
        const from = i + (label.length - label.trimStart().length);
        if (label.trim())
          push('text', label.trim(), from, from + label.trim().length);
        if (j !== -1) {
          push('op', close, j, j + close.length);
          i = j + close.length;
        } else {
          i = text.length;
        }
      }
      continue;
    }
    if (
      c === '[' ||
      c === ']' ||
      c === ',' ||
      (c === ':' && (depth > 0 || colonEnds(i)))
    ) {
      if (c === '[') depth++;
      if (c === ']') depth = Math.max(0, depth - 1);
      push('op', c, i, i + 1);
      i++;
      continue;
    }
    if (
      c === '-' &&
      i === start &&
      (i + 1 === text.length || isSpace(text[i + 1]))
    ) {
      push('op', '-', i, i + 1);
      i++;
      continue;
    }

    let j = i + 1;
    while (j < text.length && !terminates(j)) j++;
    const run = text.slice(i, j).trimEnd();
    push('text', run, i, i + run.length);
    i = j;
  }
}

function lexString(
  text: string,
  start: number,
  push: (kind: TokenKind, value: string, from: number, to: number) => void,
  diagnostics: Diagnostic[],
  span: (from: number, to: number) => Range,
): number {
  let value = '';
  let i = start + 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      push('string', value, start, i + 1);
      return i + 1;
    }
    if (c === '\\' && i + 1 < text.length) {
      const e = text[i + 1]!;
      value += e === 'n' ? '\n' : e === '"' || e === '\\' ? e : c + e;
      i += 2;
      continue;
    }
    value += c;
    i++;
  }
  diagnostics.push(
    diagnostic(
      'BT004',
      'This string has no closing quote.',
      span(start, start + 1),
      {
        fixes: [
          {
            title: 'Add the closing quote',
            edits: [{ range: span(text.length, text.length), newText: '"' }],
          },
        ],
      },
    ),
  );
  push('string', value, start, text.length);
  return text.length;
}
