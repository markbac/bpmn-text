import {
  diagnostic,
  didYouMean,
  lex,
  type Comment,
  type Diagnostic,
  type DiagnosticCode,
  type Position,
  type Range,
  type Text,
  type Token,
} from '@bpmn-text/core';
import type {
  Cell,
  Column,
  DmnAttr,
  DmnDocument,
  DmnKind,
  DocStmt,
  ElementStmt,
  LiteralStmt,
  RawLine,
  Row,
  TableStmt,
} from './ast.js';

export interface DmnParseResult {
  ast: DmnDocument;
  comments: Comment[];
  diagnostics: Diagnostic[];
}

/** The types a column, input or decision can have (dmn-notation §5.1). */
export const TYPES = [
  'string',
  'number',
  'boolean',
  'date',
  'time',
  'dateTime',
  'dayTimeDuration',
  'yearMonthDuration',
  'any',
] as const;

export type HitPolicy =
  | 'UNIQUE'
  | 'FIRST'
  | 'PRIORITY'
  | 'ANY'
  | 'COLLECT'
  | 'RULE ORDER'
  | 'OUTPUT ORDER';
export type Aggregation = 'SUM' | 'COUNT' | 'MIN' | 'MAX';

/** Hit policies by their long and short names (dmn-notation §4.3). */
export const HIT_POLICIES: Record<
  string,
  { hitPolicy: HitPolicy; aggregation?: Aggregation; canonical: string }
> = {};
for (const [canonical, short, hitPolicy, aggregation] of [
  ['unique', 'U', 'UNIQUE'],
  ['first', 'F', 'FIRST'],
  ['priority', 'P', 'PRIORITY'],
  ['any', 'A', 'ANY'],
  ['collect', 'C', 'COLLECT'],
  ['collect sum', 'C+', 'COLLECT', 'SUM'],
  ['collect count', 'C#', 'COLLECT', 'COUNT'],
  ['collect min', 'C<', 'COLLECT', 'MIN'],
  ['collect max', 'C>', 'COLLECT', 'MAX'],
  ['rule order', 'R', 'RULE ORDER'],
  ['output order', 'O', 'OUTPUT ORDER'],
] as const) {
  const entry = {
    hitPolicy,
    canonical,
    ...(aggregation ? { aggregation } : {}),
  };
  HIT_POLICIES[canonical] = entry;
  HIT_POLICIES[short] = entry;
}

const KINDS: readonly DmnKind[] = ['input', 'decision', 'knowledge', 'source'];
const STATEMENT_KEYWORDS = [...KINDS, 'title'];
const BODY_KEYWORDS = ['doc', 'table', 'literal'];
const ATTRIBUTES = [
  'requires',
  'type',
  'values',
  'params',
  'hit',
  'id',
  'doc',
  'color',
  'stroke',
];

/** The words of the DMN notation, for editors. */
export const dmnVocabulary = {
  keywords: STATEMENT_KEYWORDS,
  bodyKeywords: BODY_KEYWORDS,
  attributes: ATTRIBUTES,
  types: [...TYPES],
  hitPolicies: Object.values(HIT_POLICIES)
    .map((h) => h.canonical)
    .filter((h, i, all) => all.indexOf(h) === i),
} as const;

class SyntaxError {
  constructor(readonly diagnostic: Diagnostic) {}
}

const shift = (p: Position, by: number): Position => ({
  line: p.line,
  col: p.col + by,
  offset: p.offset + by,
});
const rangeAt = (start: Position, length: number): Range => ({
  start,
  end: shift(start, length),
});

/** Parses `.dmnt` source into an AST. Never throws. */
export function parseDmn(source: string): DmnParseResult {
  const lexed = lex(source, { raw: ['doc', 'literal'], rows: true });
  const parser = new Parser(lexed.tokens, [...lexed.diagnostics]);
  return {
    ast: parser.document(),
    comments: lexed.comments,
    diagnostics: parser.diagnostics,
  };
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    readonly diagnostics: Diagnostic[],
  ) {}

  private peek(k = 0): Token {
    return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)]!;
  }
  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.pos++;
    return t;
  }
  private isOp(value: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === 'op' && t.value === value;
  }
  private atLineEnd(): boolean {
    const k = this.peek().kind;
    return k === 'newline' || k === 'eof';
  }
  private fail(message: string, range: Range = this.peek().range): never {
    throw new SyntaxError(diagnostic('BT001', message, range));
  }
  private report(
    code: DiagnosticCode,
    message: string,
    range: Range,
    extra: Pick<Diagnostic, 'fixes' | 'related'> = {},
  ) {
    this.diagnostics.push(diagnostic(code, message, range, extra));
  }
  private endLine(): void {
    if (!this.atLineEnd()) this.fail(`Unexpected ${describe(this.peek())}.`);
    this.next();
  }
  private previousEnd(): Range {
    let i = this.pos - 1;
    while (
      i > 0 &&
      ['newline', 'indent', 'dedent'].includes(this.tokens[i]!.kind)
    )
      i--;
    return this.tokens[Math.max(0, i)]!.range;
  }
  private skipLine(): void {
    while (!this.atLineEnd()) this.next();
    this.next();
    if (this.peek().kind === 'indent') this.skipBlock();
  }
  private skipBlock(): void {
    let depth = 0;
    do {
      const t = this.next();
      if (t.kind === 'indent') depth++;
      if (t.kind === 'dedent') depth--;
      if (t.kind === 'eof') return;
    } while (depth > 0);
  }
  private line<T>(parse: () => T): T | undefined {
    const start = this.pos;
    try {
      return parse();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.diagnostics.push(error.diagnostic);
      if (
        this.pos === start ||
        this.tokens.slice(start, this.pos).every((t) => t.kind !== 'newline')
      ) {
        this.skipLine();
      }
      return undefined;
    }
  }
  /** Runs `body` over an indented block; the dedent is consumed. */
  private block(body: () => void): void {
    this.next(); // indent
    while (this.peek().kind !== 'dedent' && this.peek().kind !== 'eof') {
      const before = this.pos;
      body();
      if (this.pos === before) this.next();
    }
    this.next();
  }

  document(): DmnDocument {
    let title: Text | undefined;
    const elements: ElementStmt[] = [];
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'indent' || t.kind === 'dedent') {
        this.report('BT001', 'Unexpected indentation.', t.range);
        if (t.kind === 'indent') this.skipBlock();
        else this.next();
        continue;
      }
      if (t.kind === 'row') {
        this.line(() =>
          this.fail('A table row must be indented under `table`.', t.range),
        );
        continue;
      }
      const { word } = t.kind === 'text' ? splitFirst(t) : { word: undefined };
      if (word?.value === 'title') {
        const value = this.line(() => this.title());
        if (value) {
          if (title)
            this.report('BT001', 'Only one `title` is allowed.', value.range);
          title = value;
        }
        continue;
      }
      const e = this.line(() => this.element());
      if (e) elements.push(e);
    }
    return {
      type: 'document',
      ...(title ? { title } : {}),
      elements,
      range: {
        start: { line: 1, col: 1, offset: 0 },
        end: this.peek().range.end,
      },
    };
  }

  private title(): Text {
    const t = this.next();
    const { rest } = splitFirst(t);
    let value: Text;
    if (rest) value = { value: rest.value, quoted: false, range: rest.range };
    else if (this.peek().kind === 'string') {
      const s = this.next();
      value = { value: s.value, quoted: true, range: s.range };
    } else this.fail('Expected a name after `title`.', t.range);
    this.endLine();
    return value;
  }

  private element(): ElementStmt {
    const t = this.peek();
    if (t.kind !== 'text')
      this.fail(`Unexpected ${describe(t)}; expected an element.`);
    const { word, rest } = splitFirst(t);
    if (!(KINDS as readonly string[]).includes(word.value)) {
      const misplaced = BODY_KEYWORDS.includes(word.value);
      const suggestion = misplaced
        ? undefined
        : didYouMean(word.value, STATEMENT_KEYWORDS);
      if (misplaced)
        this.fail(
          `\`${word.value}\` must be indented under the element it belongs to.`,
          word.range,
        );
      throw new SyntaxError(
        diagnostic(
          'BT101',
          `Unknown keyword \`${word.value}\`.${suggestion ? ` Did you mean \`${suggestion}\`?` : ''}`,
          word.range,
          suggestion
            ? {
                fixes: [
                  {
                    title: `Change to \`${suggestion}\``,
                    edits: [{ range: word.range, newText: suggestion }],
                  },
                ],
              }
            : {},
        ),
      );
    }
    const kind = word.value as DmnKind;
    this.next();
    let name: Text;
    if (rest) name = { value: rest.value, quoted: false, range: rest.range };
    else if (this.peek().kind === 'string') {
      const s = this.next();
      name = { value: s.value, quoted: true, range: s.range };
    } else this.fail(`Expected a name after \`${kind}\`.`, word.range);
    let id: Text | undefined;
    if (this.peek().kind === 'id') {
      const i = this.next();
      id = { value: i.value, quoted: false, range: i.range };
    }
    const attrs = this.attrs();
    this.endLine();
    const element: ElementStmt = {
      type: 'element',
      kind,
      keyword: { value: kind, quoted: false, range: word.range },
      name,
      ...(id ? { id } : {}),
      attrs,
      docs: [],
      logic: [],
      range: { start: t.range.start, end: this.previousEnd().end },
    };
    if (this.peek().kind === 'indent') {
      this.block(() => {
        const s = this.line(() => this.bodyStatement());
        if (s?.type === 'doc') element.docs.push(s);
        else if (s) element.logic.push(s);
      });
      element.range = { start: t.range.start, end: this.previousEnd().end };
    }
    return element;
  }

  private bodyStatement(): DocStmt | TableStmt | LiteralStmt {
    const t = this.peek();
    if (t.kind === 'row')
      this.fail('A table row must be indented under `table`.', t.range);
    if (t.kind !== 'text')
      this.fail(
        `Unexpected ${describe(t)}; expected \`doc\`, \`table\` or \`literal\`.`,
      );
    const { word, rest } = splitFirst(t);
    if (word.value === 'doc' || word.value === 'literal') {
      this.next();
      const lines = this.rawText(word.value, t.range);
      const range = { start: t.range.start, end: this.previousEnd().end };
      const text = lines.map((l) => l.text).join('\n');
      if (word.value === 'doc') return { type: 'doc', text, range };
      return {
        type: 'literal',
        keyword: { value: 'literal', quoted: false, range: word.range },
        text,
        lines,
        range,
      };
    }
    if (word.value === 'table') {
      if (rest)
        this.fail('`table` takes no name; its decision names it.', rest.range);
      return this.table(t);
    }
    if ((KINDS as readonly string[]).includes(word.value))
      this.fail(
        `\`${word.value}\` must be at the top level, not indented.`,
        word.range,
      );
    const suggestion = didYouMean(word.value, BODY_KEYWORDS);
    throw new SyntaxError(
      diagnostic(
        'BT101',
        `Unknown keyword \`${word.value}\`; expected \`doc\`, \`table\` or \`literal\`.${suggestion ? ` Did you mean \`${suggestion}\`?` : ''}`,
        word.range,
        suggestion
          ? {
              fixes: [
                {
                  title: `Change to \`${suggestion}\``,
                  edits: [{ range: word.range, newText: suggestion }],
                },
              ],
            }
          : {},
      ),
    );
  }

  /** The raw text after `doc` or `literal`: the rest of the line, or the block below. */
  private rawText(keyword: string, at: Range): RawLine[] {
    const lines: RawLine[] = [];
    if (this.peek().kind === 'raw') {
      const r = this.next();
      lines.push({ text: r.value, range: r.range });
      this.endLine();
      return lines;
    }
    this.endLine();
    while (this.peek().kind === 'raw') {
      const r = this.next();
      lines.push({ text: r.value, range: r.range });
    }
    // Trailing blank lines belong to no one.
    while (lines.length && lines.at(-1)!.text === '') lines.pop();
    if (!lines.length)
      this.fail(
        `Expected text after \`${keyword}\`, or an indented block of text below it.`,
        at,
      );
    return lines;
  }

  private table(t: Token): TableStmt {
    const keywordRange = rangeAt(t.range.start, 5);
    this.next();
    const attrs = this.attrs();
    this.endLine();
    const rows: Row[] = [];
    if (this.peek().kind === 'indent') {
      this.block(() => {
        const r = this.peek();
        if (r.kind !== 'row') {
          this.line(() =>
            this.fail(
              'Expected a table row, starting with `|`.',
              r.kind === 'text' ? splitFirst(r).word.range : r.range,
            ),
          );
          return;
        }
        this.next();
        rows.push(splitRow(r));
        this.endLine();
      });
    }
    const range = { start: t.range.start, end: this.previousEnd().end };
    const keyword = { value: 'table', quoted: false, range: keywordRange };
    if (!rows.length) {
      this.report(
        'BT001',
        'Expected the rows of the table, indented under `table`, starting with a header row.',
        keywordRange,
      );
      return { type: 'table', keyword, attrs, columns: [], rows, range };
    }
    const [header, ...body] = rows as [Row, ...Row[]];
    const columns = this.columns(header);
    for (const row of body) {
      if (row.cells.length !== header.cells.length) {
        const fewer = row.cells.length < header.cells.length;
        const missing = header.cells.length - row.cells.length;
        this.report(
          'BT501',
          `This row has ${row.cells.length} cell${row.cells.length === 1 ? '' : 's'}; the header has ${header.cells.length}.`,
          row.range,
          fewer && row.closed
            ? {
                fixes: [
                  {
                    title: `Add ${missing} empty cell${missing === 1 ? '' : 's'}`,
                    edits: [
                      {
                        range: { start: row.range.end, end: row.range.end },
                        newText: `${row.range.end.offset > 0 && !/\|$/.test(row.cells.at(-1)?.raw ?? '') ? '' : ''}${' - |'.repeat(missing)}`,
                      },
                    ],
                  },
                ],
              }
            : {},
        );
      }
    }
    return {
      type: 'table',
      keyword,
      attrs,
      header,
      columns,
      rows: body,
      range,
    };
  }

  /** Reads the header row into columns, reporting BT502 and BT503. */
  private columns(header: Row): Column[] {
    const columns: Column[] = [];
    let role: Column['role'] = 'input';
    for (const cell of header.cells) {
      let text = cell.text;
      let start = cell.range.start;
      let marker: Column['marker'];
      if (text.startsWith('->') || text.startsWith('//')) {
        marker = text.slice(0, 2) as '->' | '//';
        if (marker === '//') role = 'annotation';
        else if (role === 'annotation')
          this.report(
            'BT001',
            'Output columns go before the annotation column.',
            cell.range,
          );
        else role = 'output';
        const after = text.slice(2);
        const gap = after.length - after.trimStart().length;
        start = shift(start, 2 + gap);
        text = after.trim();
      } else if (role === 'annotation') {
        this.report(
          'BT001',
          'Only one annotation column is allowed, and it comes last.',
          cell.range,
        );
      }
      const column: Column = {
        role,
        label: {
          value: text,
          quoted: false,
          range: rangeAt(start, text.length),
        },
        ...(marker ? { marker } : {}),
        range: cell.range,
      };
      if (role !== 'annotation') {
        const m = /^(.*?)\s*:\s*([A-Za-z]\w*)(?:\s+in\s+(.+))?$/.exec(text);
        if (m) {
          const [, label, type, values] = m as unknown as [
            string,
            string,
            string,
            string | undefined,
          ];
          column.label = {
            value: label,
            quoted: false,
            range: rangeAt(start, label.length),
          };
          const typeAt = text.indexOf(type, label.length);
          column.typeRef = {
            value: type,
            quoted: false,
            range: rangeAt(shift(start, typeAt), type.length),
          };
          this.checkType(column.typeRef);
          if (values) {
            const valuesAt = text.lastIndexOf(values);
            column.values = {
              value: values,
              quoted: false,
              range: rangeAt(shift(start, valuesAt), values.length),
            };
          }
        }
      }
      if (!column.label.value && role !== 'annotation')
        this.report('BT001', 'This column has no heading.', cell.range);
      columns.push(column);
    }
    if (!columns.some((c) => c.role === 'output')) {
      const first = header.cells.find((_, i) => i > 0) ?? header.cells[0];
      this.report(
        'BT502',
        'This table has no output column. Mark the first output column with `->`.',
        header.range,
        first && header.cells.length > 1
          ? {
              fixes: [
                {
                  title: `Make \`${header.cells.at(-1)!.text}\` the output`,
                  edits: [
                    {
                      range: {
                        start: header.cells.at(-1)!.range.start,
                        end: header.cells.at(-1)!.range.start,
                      },
                      newText: '-> ',
                    },
                  ],
                },
              ],
            }
          : {},
      );
    }
    return columns;
  }

  /** Reports a type that is not one of TYPES (BT503). */
  checkType(type: Text): void {
    if ((TYPES as readonly string[]).includes(type.value)) return;
    const suggestion = didYouMean(type.value, TYPES);
    this.report(
      'BT503',
      `Unknown type \`${type.value}\`.${suggestion ? ` Did you mean \`${suggestion}\`?` : ` Use one of ${TYPES.map((t) => `\`${t}\``).join(', ')}.`}`,
      type.range,
      suggestion
        ? {
            fixes: [
              {
                title: `Change to \`${suggestion}\``,
                edits: [{ range: type.range, newText: suggestion }],
              },
            ],
          }
        : {},
    );
  }

  private attrs(): DmnAttr[] {
    if (!this.isOp('[')) return [];
    const open = this.next();
    const attrs: DmnAttr[] = [];
    while (!this.isOp(']')) {
      if (this.atLineEnd())
        this.fail('This attribute list is never closed.', open.range);
      const key = this.next();
      if (key.kind !== 'text')
        this.fail(
          `Expected an attribute name, found ${describe(key)}.`,
          key.range,
        );
      if (!ATTRIBUTES.includes(key.value)) {
        const suggestion = didYouMean(key.value, ATTRIBUTES);
        this.report(
          'BT103',
          `Unknown attribute \`${key.value}\`; it has no effect.${suggestion ? ` Did you mean \`${suggestion}\`?` : ''}`,
          key.range,
          suggestion
            ? {
                fixes: [
                  {
                    title: `Change to \`${suggestion}\``,
                    edits: [{ range: key.range, newText: suggestion }],
                  },
                ],
              }
            : {},
        );
      }
      const values: Text[] = [];
      if (!this.isOp(':'))
        this.fail(`Expected \`:\` and a value after \`${key.value}\`.`);
      this.next();
      for (;;) {
        const v = this.next();
        if (v.kind !== 'text' && v.kind !== 'string') {
          if (v.kind === 'newline' || v.kind === 'eof')
            this.fail('This attribute list is never closed.', open.range);
          this.fail(`Expected a value for \`${key.value}\`.`, v.range);
        }
        values.push({
          value: v.value,
          quoted: v.kind === 'string',
          range: v.range,
        });
        const after = this.peek(1);
        const nextAttr = after.kind === 'text' && this.isOp(':', 2);
        if (this.isOp(',') && !nextAttr) {
          this.next();
          continue;
        }
        break;
      }
      const attr: DmnAttr = {
        key: { value: key.value, quoted: false, range: key.range },
        values,
        range: { start: key.range.start, end: this.previousEnd().end },
      };
      attrs.push(attr);
      if (key.value === 'type') for (const v of values) this.checkType(v);
      if (key.value === 'hit') this.checkHitPolicy(attr);
      if (this.isOp(',')) this.next();
      else if (!this.isOp(']')) {
        if (this.atLineEnd())
          this.fail('This attribute list is never closed.', open.range);
        this.fail(`Expected \`,\` or \`]\`, found ${describe(this.peek())}.`);
      }
    }
    this.next();
    return attrs;
  }

  private checkHitPolicy(attr: DmnAttr): void {
    const value = attr.values.map((v) => v.value).join(', ');
    if (attr.values.length === 1 && HIT_POLICIES[value]) return;
    const range = {
      start: attr.values[0]!.range.start,
      end: attr.values.at(-1)!.range.end,
    };
    const suggestion = didYouMean(value, dmnVocabulary.hitPolicies);
    this.report(
      'BT504',
      `Unknown hit policy \`${value}\`.${suggestion ? ` Did you mean \`${suggestion}\`?` : ` Use one of ${dmnVocabulary.hitPolicies.map((h) => `\`${h}\``).join(', ')}.`}`,
      range,
      suggestion
        ? {
            fixes: [
              {
                title: `Change to \`${suggestion}\``,
                edits: [{ range, newText: suggestion }],
              },
            ],
          }
        : {},
    );
  }
}

/** Splits a table row into cells, by unescaped `|`. */
export function splitRow(t: Token): Row {
  const text = t.value;
  const start = t.range.start;
  const cells: Cell[] = [];
  let from = 1; // after the opening `|`
  const push = (to: number) => {
    const piece = text.slice(from, to);
    const lead = piece.length - piece.trimStart().length;
    const raw = piece.trim();
    const at = shift(start, from + (raw ? lead : Math.min(1, piece.length)));
    cells.push({
      text: raw.replace(/\\\|/g, '|'),
      raw,
      range: rangeAt(at, raw.length),
    });
  };
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') {
      i++;
      continue;
    }
    if (text[i] === '|') {
      push(i);
      from = i + 1;
    }
  }
  const closed = !text.slice(from).trim();
  if (!closed) push(text.length);
  return { cells, closed, range: t.range };
}

function splitFirst(t: Token): {
  word: { value: string; range: Range };
  rest: { value: string; range: Range } | undefined;
} {
  const m = /^(\S+)(\s*)(.*)$/.exec(t.value)!;
  const [, word, gap, rest] = m as unknown as [string, string, string, string];
  return {
    word: { value: word, range: rangeAt(t.range.start, word.length) },
    rest: rest
      ? {
          value: rest,
          range: {
            start: shift(t.range.start, word.length + gap.length),
            end: t.range.end,
          },
        }
      : undefined,
  };
}

function describe(t: Token): string {
  switch (t.kind) {
    case 'newline':
    case 'eof':
      return 'end of line';
    case 'indent':
      return 'indentation';
    case 'dedent':
      return 'end of block';
    case 'string':
      return 'string';
    case 'row':
      return 'table row';
    default:
      return `\`${t.kind === 'id' ? '@' : ''}${t.value}\``;
  }
}
