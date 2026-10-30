import type {
  Attr,
  BoundaryStmt,
  Branch,
  Directive,
  Document,
  ElementDecl,
  ElementKind,
  EventType,
  FlowStep,
  Ref,
  Statement,
  Text,
} from './ast.js';
import {
  diagnostic,
  type Diagnostic,
  type Position,
  type Range,
} from './diagnostics.js';
import { lex, type Comment, type Token } from './lexer.js';
import { didYouMean } from './suggest.js';

export interface ParseResult {
  ast: Document;
  comments: Comment[];
  diagnostics: Diagnostic[];
}

const EVENT_TYPES: Record<string, readonly EventType[]> = {
  start: ['message', 'timer', 'signal', 'conditional'],
  end: [
    'message',
    'signal',
    'error',
    'escalation',
    'compensation',
    'terminate',
  ],
  catch: ['message', 'timer', 'signal', 'conditional', 'link'],
  throw: ['message', 'signal', 'escalation', 'compensation', 'link'],
  on: [
    'message',
    'timer',
    'signal',
    'error',
    'escalation',
    'conditional',
    'compensation',
  ],
};
const ALL_EVENT_TYPES = new Set(Object.values(EVENT_TYPES).flat());
const ACTIVITIES = [
  'task',
  'user',
  'service',
  'script',
  'send',
  'receive',
  'manual',
  'rule',
  'call',
];
const GATEWAYS = ['xor', 'and', 'or', 'event'];
/** Keywords that can declare an element inline, after an arrow (§6.1). */
const INLINE = new Set([
  'start',
  'end',
  'catch',
  'throw',
  'wait',
  ...ACTIVITIES,
]);
const STATEMENT_KEYWORDS = [
  ...INLINE,
  ...GATEWAYS,
  'sub',
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
];
const KEYWORDS = new Set(STATEMENT_KEYWORDS);
const FLAGS = new Set([
  'loop',
  'parallel',
  'sequential',
  'collapsed',
  'non-interrupting',
  'collection',
  'fit',
]);
const ATTRIBUTES = new Set([
  'id',
  'loop',
  'parallel',
  'sequential',
  'reads',
  'writes',
  'collapsed',
  'non-interrupting',
  'collection',
  'lane',
  'doc',
  'color',
  'stroke',
  'fit',
]);

/** Thrown inside a statement; the statement loop reports it and skips the line. */
class SyntaxError {
  constructor(readonly diagnostic: Diagnostic) {}
}

/** A word inside a text token. */
interface Word {
  value: string;
  range: Range;
}

const shift = (p: Position, by: number): Position => ({
  line: p.line,
  col: p.col + by,
  offset: p.offset + by,
});

/** The first word of a text token, and the rest of it. */
const firstWord = (t: Token) => firstWordOf({ value: t.value, range: t.range });

/** Parses bpmn-text source into an AST. Never throws. */
export function parse(source: string): ParseResult {
  const lexed = lex(source);
  const parser = new Parser(source, lexed.tokens, [...lexed.diagnostics]);
  const ast = parser.document();
  return { ast, comments: lexed.comments, diagnostics: parser.diagnostics };
}

class Parser {
  private pos = 0;

  constructor(
    private readonly source: string,
    private readonly tokens: Token[],
    readonly diagnostics: Diagnostic[],
  ) {}

  // Token access

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
  private span(start: Range, end: Range): Range {
    return { start: start.start, end: end.end };
  }
  /** The range of the last token consumed, ignoring newlines and indentation. */
  private previousEnd(): Range {
    let i = this.pos - 1;
    while (
      i > 0 &&
      ['newline', 'indent', 'dedent'].includes(this.tokens[i]!.kind)
    )
      i--;
    return this.tokens[Math.max(0, i)]!.range;
  }

  /** Skips the rest of the line and any block under it. */
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
  private endLine(): void {
    if (!this.atLineEnd()) this.fail(`Unexpected ${describe(this.peek())}.`);
    this.next();
  }
  private hasBlock(): boolean {
    return this.peek().kind === 'indent';
  }

  /** Runs `parse` for one line, reporting and skipping the line on a syntax error. */
  private line<T>(parse: () => T): T | undefined {
    const start = this.pos;
    try {
      return parse();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.diagnostics.push(error.diagnostic);
      // Skip what is left of the line the statement started on.
      if (
        this.pos === start ||
        this.tokens.slice(start, this.pos).every((t) => t.kind !== 'newline')
      ) {
        this.skipLine();
      }
      return undefined;
    }
  }

  // Document

  document(): Document {
    const directives: Directive[] = [];
    const body: Statement[] = [];
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'indent' || t.kind === 'dedent') {
        this.diagnostics.push(
          diagnostic('BT001', 'Unexpected indentation.', t.range),
        );
        if (t.kind === 'indent') this.skipBlock();
        else this.next();
        continue;
      }
      const keyword = t.kind === 'text' ? firstWord(t).word.value : '';
      if (keyword === 'title' || keyword === 'option') {
        const d = this.line(() => this.directive());
        if (d) directives.push(d);
        continue;
      }
      const s = this.line(() => this.statement(true));
      if (s) body.push(s);
    }
    const end = this.peek().range;
    return {
      type: 'document',
      directives,
      body,
      range: { start: { line: 1, col: 1, offset: 0 }, end: end.end },
    };
  }

  private directive(): Directive {
    const t = this.next();
    const { word, rest } = firstWord(t);
    if (word.value === 'title') {
      const value = rest ? this.textOf(rest) : this.name('title');
      this.endLine();
      return { type: 'title', value, range: this.span(t.range, value.range) };
    }
    const words = rest ? splitWords(rest) : [];
    if (words.length !== 2)
      this.fail(
        'Expected `option <key> <value>`, such as `option xor-join direct`.',
        t.range,
      );
    this.endLine();
    const [key, value] = words.map((w) => this.textOf(w)) as [Text, Text];
    return { type: 'option', key, value, range: t.range };
  }

  // Statements

  /** Statements until the end of the current block (the dedent is consumed). */
  private block(): Statement[] {
    const body: Statement[] = [];
    this.next(); // indent
    while (this.peek().kind !== 'dedent' && this.peek().kind !== 'eof') {
      const s = this.line(() => this.statement(false));
      if (s) body.push(s);
    }
    this.next();
    return body;
  }

  private statement(topLevel: boolean): Statement {
    const t = this.peek();
    if (t.kind === 'op' && (t.value === '->' || t.value === '-(')) {
      const tail = this.tail();
      this.endLine();
      return {
        type: 'goto',
        tail,
        range: this.span(t.range, tail.at(-1)!.range),
      };
    }
    if (t.kind === 'string' || t.kind === 'id') return this.messageStatement();
    if (t.kind !== 'text')
      this.fail(`Unexpected ${describe(t)}; expected a statement.`);

    const { word, rest } = firstWord(t);
    const keyword = word.value;
    if (!KEYWORDS.has(keyword)) {
      if (this.isOp('~>', 1) || this.isOp('~(', 1))
        return this.messageStatement();
      const suggestion = didYouMean(keyword, STATEMENT_KEYWORDS);
      throw new SyntaxError(
        diagnostic(
          'BT101',
          `Unknown keyword \`${keyword}\`.${suggestion ? ` Did you mean \`${suggestion}\`?` : ''}`,
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

    switch (keyword) {
      case 'pool': {
        if (!topLevel)
          this.fail(
            'A pool can only be declared at the top level.',
            word.range,
          );
        this.next();
        const name = this.name('pool', rest);
        const attrs = this.attrs();
        this.endLine();
        const body = this.hasBlock() ? this.block() : undefined;
        return {
          type: 'pool',
          name,
          attrs,
          ...(body ? { body } : {}),
          range: this.span(t.range, this.previousEnd()),
        };
      }
      case 'lane':
      case 'group':
      case 'data':
      case 'store': {
        this.next();
        const name = this.name(keyword, rest);
        const attrs = this.attrs();
        this.endLine();
        const range = this.span(t.range, this.previousEnd());
        if (keyword === 'lane') return { type: 'lane', name, attrs, range };
        if (keyword !== 'group')
          return { type: 'data', kind: keyword, name, attrs, range };
        if (!this.hasBlock())
          this.fail(
            'Expected an indented block of elements under `group`.',
            word.range,
          );
        return {
          type: 'group',
          name,
          attrs,
          body: this.block(),
          range: this.span(t.range, this.previousEnd()),
        };
      }
      case 'lanes': {
        this.next();
        const lanes: { name: Text; attrs: Attr[]; range: Range }[] = [];
        let first: Word | undefined = rest;
        for (;;) {
          const startRange = first?.range ?? this.peek().range;
          const name = this.name('lanes', first, { stopAtComma: true });
          first = undefined;
          const attrs = this.attrs();
          lanes.push({
            name,
            attrs,
            range: this.span(startRange, this.previousEnd()),
          });
          if (!this.isOp(',')) break;
          this.next();
        }
        this.endLine();
        return {
          type: 'lanes',
          lanes,
          range: this.span(t.range, this.previousEnd()),
        };
      }
      case 'note': {
        this.next();
        const text = this.name('note', rest);
        this.endLine();
        return { type: 'note', text, range: this.span(t.range, text.range) };
      }
      case 'doc':
        return this.doc();
      case 'fork': {
        this.next();
        if (rest) this.fail('`fork` takes no name.', rest.range);
        this.endLine();
        if (!this.hasBlock())
          this.fail('Expected a block of branches under `fork`.', word.range);
        const branches = this.branches('fork');
        return {
          type: 'fork',
          branches,
          range: this.span(t.range, this.previousEnd()),
        };
      }
      case 'on':
        this.fail(
          'A boundary event (`on`) must be indented under an activity.',
          word.range,
        );
        break;
      case 'title':
      case 'option':
        this.fail(`\`${keyword}\` must be at the top level.`, word.range);
        break;
    }

    const element = this.element();
    if (GATEWAYS.includes(element.kind)) {
      this.endLine();
      const branches = this.hasBlock()
        ? this.branches(element.kind)
        : undefined;
      return {
        type: 'gateway',
        element,
        ...(branches ? { branches } : {}),
        range: this.span(t.range, this.previousEnd()),
      };
    }
    if (element.kind === 'sub') {
      this.endLine();
      if (!this.hasBlock()) {
        return { type: 'sub', element, boundaries: [], range: element.range };
      }
      const body: Statement[] = [];
      const boundaries: BoundaryStmt[] = [];
      this.next();
      while (this.peek().kind !== 'dedent' && this.peek().kind !== 'eof') {
        if (this.startsWith('on')) {
          const b = this.line(() => this.boundary());
          if (b) boundaries.push(b);
        } else {
          const s = this.line(() => this.statement(false));
          if (s) body.push(s);
        }
      }
      this.next();
      return {
        type: 'sub',
        element,
        body,
        boundaries,
        range: this.span(t.range, this.previousEnd()),
      };
    }

    const tail = this.tail();
    this.endLine();
    const boundaries: BoundaryStmt[] = [];
    if (this.hasBlock()) {
      if (!ACTIVITIES.includes(element.kind)) {
        this.diagnostics.push(
          diagnostic(
            'BT001',
            'Only activities can have an indented block of boundary events.',
            this.peek().range,
          ),
        );
        this.skipBlock();
      } else {
        this.next();
        while (this.peek().kind !== 'dedent' && this.peek().kind !== 'eof') {
          const b = this.line(() => {
            if (!this.startsWith('on'))
              this.fail(
                'Expected a boundary event (`on <type> …`) under an activity.',
              );
            return this.boundary();
          });
          if (b) boundaries.push(b);
        }
        this.next();
      }
    }
    return {
      type: 'element-stmt',
      element,
      tail,
      boundaries,
      range: this.span(t.range, this.previousEnd()),
    };
  }

  private startsWith(keyword: string): boolean {
    const t = this.peek();
    return t.kind === 'text' && firstWord(t).word.value === keyword;
  }

  private boundary(): BoundaryStmt {
    const start = this.peek().range;
    const element = this.element();
    const tail = this.tail();
    this.endLine();
    const body = this.hasBlock() ? this.block() : [];
    return {
      type: 'boundary',
      element,
      tail,
      body,
      range: this.span(start, this.previousEnd()),
    };
  }

  private messageStatement(): Statement {
    const source = this.reference(false);
    if (!this.isOp('~>') && !this.isOp('~(')) {
      this.fail('Expected `~>` after the source of a message flow.');
    }
    const [step] = this.tail(true);
    this.endLine();
    return {
      type: 'message',
      source,
      step: step!,
      range: this.span(source.range, step!.range),
    };
  }

  private doc(): Statement {
    const t = this.next();
    let text: string;
    if (this.peek().kind === 'raw') {
      text = this.next().value;
      this.endLine();
    } else {
      this.endLine();
      const lines: string[] = [];
      while (this.peek().kind === 'raw') lines.push(this.next().value);
      if (!lines.length)
        this.fail(
          'Expected text after `doc`, or an indented block of text below it.',
          t.range,
        );
      text = lines.join('\n');
    }
    return { type: 'doc', text, range: this.span(t.range, this.previousEnd()) };
  }

  // Gateways and branches

  private branches(gateway: ElementKind | 'fork'): Branch[] {
    const branches: Branch[] = [];
    this.next(); // indent
    while (this.peek().kind !== 'dedent' && this.peek().kind !== 'eof') {
      const b = this.line(() => this.branch(gateway));
      if (b) branches.push(b);
    }
    this.next();
    return branches;
  }

  private branch(gateway: ElementKind | 'fork'): Branch {
    const t = this.peek();
    let form: Branch['form'];
    let label: Text | undefined;
    if (this.isOp('-')) {
      this.next();
      form = 'bullet';
    } else if (
      (t.kind === 'text' || t.kind === 'string') &&
      this.isOp(':', 1)
    ) {
      this.next();
      this.next();
      if (t.kind === 'text' && t.value === 'else') {
        if (gateway === 'and' || gateway === 'event' || gateway === 'fork') {
          const kind =
            gateway === 'fork'
              ? '`fork`'
              : gateway === 'and'
                ? 'a parallel gateway'
                : 'an event-based gateway';
          this.diagnostics.push(
            diagnostic(
              'BT221',
              `\`else:\` has no meaning on ${kind}; every branch is taken.`,
              t.range,
            ),
          );
          form = 'bullet';
        } else {
          form = 'else';
        }
      } else {
        form = 'labelled';
        label = { value: t.value, quoted: t.kind === 'string', range: t.range };
      }
    } else {
      this.fail('Expected a branch: `label:`, `-` or `else:`.');
    }

    let inline: Branch['inline'];
    if (!this.atLineEnd()) {
      const target = this.target(false);
      inline = { target, tail: this.tail() };
    }
    this.endLine();
    const body = this.hasBlock() ? this.block() : [];
    return {
      type: 'branch',
      form,
      ...(label ? { label } : {}),
      ...(inline ? { inline } : {}),
      body,
      range: this.span(t.range, this.previousEnd()),
    };
  }

  // Elements

  /** An element declaration starting at a text token whose first word is a keyword. */
  private element(): ElementDecl {
    const t = this.next();
    const { word, rest: afterKeyword } = firstWord(t);
    let rest = afterKeyword;
    const keyword: Text = {
      value: word.value,
      quoted: false,
      range: word.range,
    };
    let kind = word.value as ElementKind;
    let eventType: EventType | undefined;

    if (word.value === 'wait') {
      kind = 'catch';
      eventType = 'timer';
    } else if (EVENT_TYPES[word.value]) {
      const typeWord = rest ? firstWordOf(rest) : undefined;
      if (typeWord && ALL_EVENT_TYPES.has(typeWord.word.value as EventType)) {
        const type = typeWord.word.value as EventType;
        if (EVENT_TYPES[word.value]!.includes(type)) eventType = type;
        else {
          this.diagnostics.push(
            diagnostic(
              'BT102',
              `\`${word.value} ${type}\` is not allowed. Event types for \`${word.value}\`: ${EVENT_TYPES[word.value]!.join(', ')}.`,
              typeWord.word.range,
            ),
          );
        }
        rest = typeWord.rest;
      } else if (word.value === 'on') {
        throw new SyntaxError(
          diagnostic(
            'BT102',
            `A boundary event needs an event type: ${EVENT_TYPES.on!.join(', ')}.`,
            typeWord?.word.range ?? word.range,
          ),
        );
      }
    }

    const needsName =
      ACTIVITIES.includes(kind) || kind === 'sub' || word.value === 'wait';
    let name: Text | undefined;
    if (rest || this.peek().kind === 'string' || this.continuesName()) {
      name = this.name(word.value, rest);
    } else if (needsName) {
      this.fail(`Expected a name after \`${word.value}\`.`, word.range);
    }

    let id: Text | undefined;
    let attrs: Attr[] = [];
    for (;;) {
      const p = this.peek();
      if (p.kind === 'id' && !id) {
        this.next();
        id = { value: p.value, quoted: false, range: p.range };
      } else if (this.isOp('[') && !attrs.length) {
        attrs = this.attrs();
      } else break;
    }
    return {
      type: 'element',
      kind,
      keyword,
      ...(eventType ? { eventType } : {}),
      ...(name ? { name } : {}),
      ...(id ? { id } : {}),
      attrs,
      range: this.span(t.range, this.previousEnd()),
    };
  }

  /** Whether the next tokens continue a name, as in `task A, B` or `task Note: x`. */
  private continuesName(): boolean {
    return (this.isOp(',') || this.isOp(':')) && this.peek(1).kind === 'text';
  }

  /**
   * A name: a quoted string, or bare text that may contain `,` and `:`
   * (unless `stopAtComma`). `first` is text already split off a token.
   */
  private name(
    keyword: string,
    first?: Word,
    options: { stopAtComma?: boolean } = {},
  ): Text {
    if (!first && this.peek().kind === 'string') {
      const t = this.next();
      return { value: t.value, quoted: true, range: t.range };
    }
    let start: Position | undefined = first?.range.start;
    let end: Position | undefined = first?.range.end;
    if (!first) {
      if (this.peek().kind !== 'text')
        this.fail(`Expected a name after \`${keyword}\`.`);
      const t = this.next();
      start = t.range.start;
      end = t.range.end;
    }
    while (
      (this.isOp(':') || (this.isOp(',') && !options.stopAtComma)) &&
      this.peek(1).kind === 'text'
    ) {
      this.next();
      end = this.next().range.end;
    }
    const range = { start: start!, end: end! };
    return {
      value: this.source.slice(start!.offset, end!.offset),
      quoted: false,
      range,
    };
  }

  private textOf(w: Word): Text {
    const quoted = /^".*"$/.test(w.value);
    return {
      value: quoted ? w.value.slice(1, -1) : w.value,
      quoted,
      range: w.range,
    };
  }

  // Attributes

  private attrs(): Attr[] {
    if (!this.isOp('[')) return [];
    const open = this.next();
    const attrs: Attr[] = [];
    while (!this.isOp(']')) {
      if (this.atLineEnd())
        this.fail('This attribute list is never closed.', open.range);
      const key = this.next();
      if (key.kind !== 'text')
        this.fail(
          `Expected an attribute name, found ${describe(key)}.`,
          key.range,
        );
      if (!ATTRIBUTES.has(key.value)) {
        const suggestion = didYouMean(key.value, ATTRIBUTES);
        this.diagnostics.push(
          diagnostic(
            'BT103',
            `Unknown attribute \`${key.value}\`; it is kept but has no effect.${suggestion ? ` Did you mean \`${suggestion}\`?` : ''}`,
            key.range,
          ),
        );
      }
      const values: Text[] = [];
      if (this.isOp(':')) {
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
          // `, key:` or `, flag` starts the next attribute (§4.5);
          // `, value` continues the list.
          const after = this.peek(1);
          const nextAttr =
            after.kind === 'text' &&
            (this.isOp(':', 2) || FLAGS.has(after.value));
          if (this.isOp(',') && !nextAttr) {
            this.next();
            continue;
          }
          break;
        }
      }
      attrs.push({
        key: { value: key.value, quoted: false, range: key.range },
        values,
        range: this.span(key.range, this.previousEnd()),
      });
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

  // Flows

  private tail(messageOnly = false): FlowStep[] {
    const steps: FlowStep[] = [];
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'op') break;
      let op: FlowStep['op'];
      let label: Text | undefined;
      if (t.value === '->' || t.value === '-(') op = 'sequence';
      else if (t.value === '~>' || t.value === '~(') op = 'message';
      else break;
      if (messageOnly && op === 'sequence') break;
      this.next();
      if (t.value === '-(' || t.value === '~(') {
        const close = t.value === '-(' ? ')->' : ')~>';
        const l = this.next();
        if (l.kind !== 'text')
          this.fail(`Expected a label and \`${close}\`.`, t.range);
        label = { value: l.value, quoted: false, range: l.range };
        if (!this.isOp(close))
          this.fail(`Expected \`${close}\` to close the label.`, t.range);
        this.next();
      }
      if (this.atLineEnd())
        this.fail(`Expected a target after \`${t.value}\`.`, t.range);
      const targets: (ElementDecl | Ref)[] = [this.target(op === 'message')];
      if (op === 'sequence' && targets[0]!.type === 'ref') {
        while (this.isOp(',')) {
          this.next();
          targets.push(this.reference(true));
        }
      }
      steps.push({
        op,
        ...(label ? { label } : {}),
        targets,
        range: this.span(t.range, this.previousEnd()),
      });
      if (messageOnly) break;
    }
    return steps;
  }

  /** An inline declaration if the text starts with a keyword, else a reference. */
  private target(message: boolean): ElementDecl | Ref {
    const t = this.peek();
    if (t.kind === 'text') {
      const keyword = firstWord(t).word.value;
      if (INLINE.has(keyword)) return this.element();
      if (KEYWORDS.has(keyword)) {
        this.fail(
          `\`${keyword}\` cannot be declared inline. To refer to an element whose name starts with \`${keyword}\`, quote the name.`,
          firstWord(t).word.range,
        );
      }
    }
    return this.reference(!message);
  }

  private reference(inList: boolean): Ref {
    const t = this.peek();
    if (t.kind === 'id') {
      this.next();
      return {
        type: 'ref',
        id: { value: t.value, quoted: false, range: t.range },
        range: t.range,
      };
    }
    if (t.kind === 'string') {
      this.next();
      return {
        type: 'ref',
        name: { value: t.value, quoted: true, range: t.range },
        range: t.range,
      };
    }
    if (t.kind !== 'text')
      this.fail(`Expected a name or @id, found ${describe(t)}.`);
    const name = this.name('', undefined, { stopAtComma: inList });
    return { type: 'ref', name, range: name.range };
  }
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
    default:
      return `\`${t.kind === 'id' ? '@' : ''}${t.value}\``;
  }
}

/** The first word of `w`, and the rest of it. */
function firstWordOf(w: Word): { word: Word; rest: Word | undefined } {
  const m = /^(\S+)(\s*)(.*)$/.exec(w.value)!;
  const [, word, gap, rest] = m as unknown as [string, string, string, string];
  return {
    word: {
      value: word,
      range: { start: w.range.start, end: shift(w.range.start, word.length) },
    },
    rest: rest
      ? {
          value: rest,
          range: {
            start: shift(w.range.start, word.length + gap.length),
            end: w.range.end,
          },
        }
      : undefined,
  };
}

function splitWords(w: Word): Word[] {
  const words: Word[] = [];
  for (const m of w.value.matchAll(/"[^"]*"|\S+/g)) {
    const start = shift(w.range.start, m.index);
    words.push({
      value: m[0],
      range: { start, end: shift(start, m[0].length) },
    });
  }
  return words;
}
