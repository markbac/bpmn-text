import {
  diagnostic,
  didYouMean,
  type Diagnostic,
  type Position,
  type Range,
} from '@bpmn-text/core';
import type { SyntaxNode, Tree } from '@lezer/common';
import { parser, trackVariables } from 'lezer-feel';
import type {
  DecisionTable,
  DmnElement,
  DmnModel,
  Entry,
  LiteralExpression,
} from './model.js';

/** A numeric interval; dates are days since 1970-01-01. */
export interface Interval {
  lo: number;
  hi: number;
  loClosed: boolean;
  hiClosed: boolean;
}

/**
 * What an input entry matches, for the table checks:
 * - `any`: `-`;
 * - `numbers`: a union of intervals (numbers and dates);
 * - `values`: strings or booleans, or everything but them when `negated`;
 * - `unknown`: anything the checks cannot reason about.
 */
export type EntryMeaning =
  | { kind: 'any' }
  | { kind: 'numbers'; domain: 'number' | 'date'; intervals: Interval[] }
  | {
      kind: 'values';
      domain: 'string' | 'boolean';
      values: string[];
      negated: boolean;
    }
  | { kind: 'unknown' };

export interface FeelResult {
  diagnostics: Diagnostic[];
  /** Input entry ID → its meaning. */
  entries: Map<string, EntryMeaning>;
}

/** FEEL's built-in functions (DMN 1.3 §10.3.4), which need no requirement. */
const BUILT_INS = new Set([
  'date',
  'time',
  'date and time',
  'duration',
  'years and months duration',
  'number',
  'string',
  'substring',
  'string length',
  'upper case',
  'lower case',
  'substring before',
  'substring after',
  'replace',
  'contains',
  'starts with',
  'ends with',
  'matches',
  'split',
  'string join',
  'list contains',
  'count',
  'min',
  'max',
  'sum',
  'mean',
  'all',
  'any',
  'sublist',
  'append',
  'concatenate',
  'insert before',
  'remove',
  'reverse',
  'index of',
  'union',
  'distinct values',
  'flatten',
  'product',
  'median',
  'stddev',
  'mode',
  'decimal',
  'floor',
  'ceiling',
  'abs',
  'modulo',
  'sqrt',
  'log',
  'exp',
  'odd',
  'even',
  'before',
  'after',
  'meets',
  'met by',
  'overlaps',
  'overlaps before',
  'overlaps after',
  'finishes',
  'finished by',
  'includes',
  'during',
  'starts',
  'started by',
  'coincides',
  'day of year',
  'day of week',
  'month of year',
  'week of year',
  'not',
  'get value',
  'get entries',
  'context',
  'context put',
  'context merge',
  'now',
  'today',
  'sort',
  'round up',
  'round down',
  'round half up',
  'round half down',
  'is',
  'is defined',
]);

/** Constructs that bind names of their own; names under them are not checked. */
const BINDING = new Set([
  'ForExpression',
  'QuantifiedExpression',
  'FunctionDefinition',
  'Context',
  'FilterExpression',
  'PathExpression',
]);

const unaryParsers = new Map<string, ReturnType<typeof parser.configure>>();
function feelParser(top: 'UnaryTests' | 'Expression', names: string[]) {
  const key = `${top}\u0000${names.join('\u0000')}`;
  let p = unaryParsers.get(key);
  if (!p) {
    const context: Record<string, number> = {};
    for (const n of names) context[n] = 1;
    p = parser.configure({ top, contextTracker: trackVariables(context) });
    unaryParsers.set(key, p);
  }
  return p;
}

/** Text as parsed, with a way back from offsets to source positions. */
interface Source {
  text: string;
  at(offset: number): Position;
  whole: Range;
}

function single(text: string, range: Range): Source {
  return {
    text,
    whole: range,
    at: (o) => ({
      line: range.start.line,
      col: range.start.col + o,
      offset: range.start.offset + o,
    }),
  };
}

/** A cell's source: its text as written, with `\|` counted as two characters. */
function cell(entry: Entry): Source {
  const s = single(entry.text, entry.range);
  return {
    ...s,
    at: (o) => {
      // Each unescaped `|` before `o` stood for two characters.
      const pipes = entry.text.slice(0, o).split('|').length - 1;
      return s.at(o + pipes);
    },
  };
}

function lines(l: LiteralExpression): Source {
  const starts: number[] = [];
  let n = 0;
  for (const line of l.lines) {
    starts.push(n);
    n += line.text.length + 1;
  }
  return {
    text: l.text,
    whole: {
      start: l.lines[0]?.range.start ?? l.range.start,
      end: l.lines.at(-1)?.range.end ?? l.range.end,
    },
    at: (o) => {
      let i = starts.length - 1;
      while (i > 0 && starts[i]! > o) i--;
      const line = l.lines[i]!;
      const within = Math.min(o - starts[i]!, line.text.length);
      return {
        line: line.range.start.line,
        col: line.range.start.col + within,
        offset: line.range.start.offset + within,
      };
    },
  };
}

const rangeOf = (s: Source, from: number, to: number): Range => ({
  start: s.at(from),
  end: s.at(Math.max(from, to)),
});

/**
 * Parses the FEEL in every table cell, input expression and literal of
 * `model`, reporting syntax errors (BT520), type mismatches (BT521),
 * unknown names (BT522) and values outside a column's allowed values
 * (BT523), and reads each input entry for the table checks.
 */
export function analyseFeel(model: DmnModel): FeelResult {
  const diagnostics: Diagnostic[] = [];
  const entries = new Map<string, EntryMeaning>();
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const required = new Map<string, DmnElement[]>();
  for (const r of model.requirements) {
    const list = required.get(r.to) ?? [];
    const from = byId.get(r.from);
    if (from && from.kind !== 'source') list.push(from);
    required.set(r.to, list);
  }

  for (const e of model.elements) {
    if (e.kind !== 'decision' && e.kind !== 'knowledge') continue;
    if (!e.logic) continue;
    const visible = [
      ...(required.get(e.id) ?? []).map((r) => r.name),
      ...(e.kind === 'knowledge' ? e.params.map((p) => p.name) : []),
    ];
    if (e.logic.type === 'literal') {
      const source = lines(e.logic);
      const tree = feelParser('Expression', visible).parse(source.text);
      if (!syntax(tree, source, diagnostics, 'expression'))
        names(tree, source, visible, diagnostics);
      continue;
    }
    table(e.logic, visible, diagnostics, entries);
  }
  return { diagnostics, entries };
}

function table(
  t: DecisionTable,
  visible: string[],
  diagnostics: Diagnostic[],
  entries: Map<string, EntryMeaning>,
) {
  if (!t.outputs.length) return;
  for (const input of t.inputs) {
    const source = single(input.expression, input.expressionRange);
    const tree = feelParser('Expression', visible).parse(source.text);
    if (!syntax(tree, source, diagnostics, 'input expression'))
      names(tree, source, visible, diagnostics);
  }
  const allowed = (values: string | undefined) => {
    if (!values) return undefined;
    const tree = feelParser('UnaryTests', visible).parse(values);
    const m = meaning(tree, values);
    return m.kind === 'values' && !m.negated ? m.values : undefined;
  };
  const inputValues = t.inputs.map((i) => allowed(i.values));
  const outputValues = t.outputs.map((o) => allowed(o.values));

  for (const rule of t.rules) {
    rule.inputEntries.forEach((entry, i) => {
      const column = t.inputs[i];
      const source = cell(entry);
      const tree = feelParser('UnaryTests', [...visible, '?']).parse(
        source.text,
      );
      if (syntax(tree, source, diagnostics, 'unary test')) {
        entries.set(entry.id, { kind: 'unknown' });
        return;
      }
      const m = meaning(tree, source.text);
      entries.set(entry.id, m);
      if (!column) return;
      if (
        !typeCheck(literals(tree, source), column.typeRef, source, diagnostics)
      )
        entries.set(entry.id, { kind: 'unknown' });
      valueCheck(literals(tree, source), inputValues[i], source, diagnostics);
    });
    rule.outputEntries.forEach((entry, o) => {
      if (!entry.text) return;
      const column = t.outputs[o];
      const source = cell(entry);
      const tree = feelParser('Expression', visible).parse(source.text);
      if (syntax(tree, source, diagnostics, 'expression')) return;
      names(tree, source, visible, diagnostics);
      const top = tree.topNode.firstChild;
      // Only a literal on its own says what type the output is.
      if (top && LITERAL_TYPES[top.name]) {
        const lit = [{ node: top, text: source.text.slice(top.from, top.to) }];
        typeCheck(lit, column?.typeRef, source, diagnostics);
        valueCheck(lit, outputValues[o], source, diagnostics);
      }
    });
  }
}

/** Reports the first syntax error in `tree`; returns whether there was one. */
function syntax(
  tree: Tree,
  source: Source,
  diagnostics: Diagnostic[],
  what: string,
): boolean {
  if (!source.text.trim()) return false;
  let error: SyntaxNode | undefined;
  tree.iterate({
    enter(n) {
      if (error) return false;
      if (n.type.isError) error = n.node;
      return undefined;
    },
  });
  if (!error) return false;
  const from = Math.min(error.from, source.text.length);
  const at =
    error.from >= source.text.trimEnd().length
      ? 'It ends too early.'
      : `It cannot be read from \`${source.text.slice(from, from + 12)}\`${from + 12 < source.text.length ? '…' : ''}.`;
  diagnostics.push(
    diagnostic(
      'BT520',
      `This is not a valid FEEL ${what}. ${at}`,
      source.text.length <= 1 || error.from >= source.text.trimEnd().length
        ? source.whole.start.line === source.whole.end.line
          ? source.whole
          : rangeOf(source, 0, source.text.length)
        : rangeOf(source, from, source.text.length),
    ),
  );
  return true;
}

/** Reports names that are neither requirements, parameters nor built-ins. */
function names(
  tree: Tree,
  source: Source,
  visible: string[],
  diagnostics: Diagnostic[],
) {
  const known = new Set(visible.map((v) => v.toLowerCase()));
  tree.iterate({
    enter(n) {
      if (BINDING.has(n.name)) return false;
      if (n.name !== 'VariableName') return undefined;
      const name = source.text.slice(n.from, n.to).replace(/\s+/g, ' ');
      const parent = n.node.parent;
      const callee =
        parent?.name === 'FunctionInvocation' &&
        parent.firstChild?.from === n.from;
      if (known.has(name.toLowerCase()) || name === '?') return false;
      if (callee && BUILT_INS.has(name)) return false;
      const suggestion = didYouMean(name, visible);
      diagnostics.push(
        diagnostic(
          'BT522',
          `\`${name}\` is not a requirement of this element${suggestion ? `. Did you mean \`${suggestion}\`?` : `; add it to \`requires\`.`}`,
          rangeOf(source, n.from, n.to),
          suggestion
            ? {
                fixes: [
                  {
                    title: `Change to \`${suggestion}\``,
                    edits: [
                      {
                        range: rangeOf(source, n.from, n.to),
                        newText: suggestion,
                      },
                    ],
                  },
                ],
              }
            : {},
        ),
      );
      return false;
    },
  });
}

const LITERAL_TYPES: Record<string, string> = {
  NumericLiteral: 'number',
  StringLiteral: 'string',
  BooleanLiteral: 'boolean',
  DateTimeLiteral: 'date',
};

/** The literals a unary test compares with, such as `700` in `>= 700`. */
function literals(tree: Tree, source: Source) {
  const found: { node: SyntaxNode; text: string }[] = [];
  tree.iterate({
    enter(n) {
      if (LITERAL_TYPES[n.name]) {
        found.push({ node: n.node, text: source.text.slice(n.from, n.to) });
        return false;
      }
      // Arithmetic and calls compute values the checks do not follow.
      if (
        n.name === 'ArithmeticExpression' ||
        n.name === 'FunctionInvocation' ||
        n.name === 'VariableName'
      )
        return false;
      return undefined;
    },
  });
  return found;
}

/** The FEEL type of a literal: `date`, `time` and so on for constructors. */
function literalType(node: SyntaxNode, text: string): string {
  if (node.name !== 'DateTimeLiteral') return LITERAL_TYPES[node.name]!;
  const fn = /^\s*([a-z ]+?)\s*\(/.exec(text)?.[1];
  if (fn === 'date and time') return 'dateTime';
  if (fn === 'duration') return 'duration';
  return fn ?? 'date';
}

function typeCheck(
  found: { node: SyntaxNode; text: string }[],
  typeRef: string | undefined,
  source: Source,
  diagnostics: Diagnostic[],
): boolean {
  if (!typeRef || typeRef === 'any') return true;
  for (const { node, text } of found) {
    const type = literalType(node, text);
    const fits =
      type === typeRef ||
      (type === 'duration' &&
        (typeRef === 'dayTimeDuration' || typeRef === 'yearMonthDuration'));
    if (fits) continue;
    diagnostics.push(
      diagnostic(
        'BT521',
        `\`${text}\` is a ${type}, but this column holds ${article(typeRef)} ${typeRef}.`,
        rangeOf(source, node.from, node.to),
      ),
    );
    return false;
  }
  return true;
}

function valueCheck(
  found: { node: SyntaxNode; text: string }[],
  allowed: string[] | undefined,
  source: Source,
  diagnostics: Diagnostic[],
) {
  if (!allowed) return;
  for (const { node, text } of found) {
    if (node.name !== 'StringLiteral' && node.name !== 'BooleanLiteral')
      continue;
    const value = node.name === 'StringLiteral' ? unquote(text) : text;
    if (allowed.includes(value)) continue;
    const suggestion = didYouMean(value, allowed);
    diagnostics.push(
      diagnostic(
        'BT523',
        `${text} is not one of this column's values (${allowed.map((a) => JSON.stringify(a)).join(', ')}).${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
        rangeOf(source, node.from, node.to),
        suggestion
          ? {
              fixes: [
                {
                  title: `Change to "${suggestion}"`,
                  edits: [
                    {
                      range: rangeOf(source, node.from, node.to),
                      newText: JSON.stringify(suggestion),
                    },
                  ],
                },
              ],
            }
          : {},
      ),
    );
  }
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
const unquote = (s: string) => {
  try {
    return JSON.parse(s) as string;
  } catch {
    return s.slice(1, -1);
  }
};

/** Reads a parsed unary test into the form the table checks use. */
export function meaning(tree: Tree, text: string): EntryMeaning {
  const top = tree.topNode;
  const children = kids(top);
  if (children.length === 1 && children[0]!.name === 'Wildcard')
    return { kind: 'any' };
  if (!text.trim()) return { kind: 'any' };
  let negated = false;
  const tests = children.find((c) => c.name === 'PositiveUnaryTests');
  if (children[0]?.name === 'not') {
    negated = true;
  }
  if (!tests) return { kind: 'unknown' };
  const parts = kids(tests).filter((c) => c.name === 'PositiveUnaryTest');
  const intervals: Interval[] = [];
  const values: string[] = [];
  let domain: string | undefined;
  const join = (d: string) => {
    if (domain && domain !== d) return false;
    domain = d;
    return true;
  };
  for (const part of parts) {
    const [inner] = kids(part);
    if (!inner) return { kind: 'unknown' };
    const read = (n: SyntaxNode) => literal(n, text);
    if (inner.name === 'SimplePositiveUnaryTest') {
      const [first, second, third] = kids(inner);
      if (first?.name === 'CompareOp' && second) {
        const v = read(second);
        if (!v || v.domain === 'string' || v.domain === 'boolean')
          return { kind: 'unknown' };
        if (!join(v.domain)) return { kind: 'unknown' };
        const op = text.slice(first.from, first.to);
        const x = v.value as number;
        if (op === '<')
          intervals.push({
            lo: -Infinity,
            hi: x,
            loClosed: false,
            hiClosed: false,
          });
        else if (op === '<=')
          intervals.push({
            lo: -Infinity,
            hi: x,
            loClosed: false,
            hiClosed: true,
          });
        else if (op === '>')
          intervals.push({
            lo: x,
            hi: Infinity,
            loClosed: false,
            hiClosed: false,
          });
        else if (op === '>=')
          intervals.push({
            lo: x,
            hi: Infinity,
            loClosed: true,
            hiClosed: false,
          });
        else if (op === '=')
          intervals.push({ lo: x, hi: x, loClosed: true, hiClosed: true });
        else return { kind: 'unknown' };
        continue;
      }
      if (first?.name === 'Interval') {
        const ends = kids(first);
        const open = text.slice(ends[0]!.from, ends[0]!.to);
        const close = text.slice(ends.at(-1)!.from, ends.at(-1)!.to);
        const bounds = ends.filter(
          (n) => n.name !== '..' && n !== ends[0] && n !== ends.at(-1),
        );
        const [lo, hi] = bounds.map(read);
        if (!lo || !hi || lo.domain !== hi.domain) return { kind: 'unknown' };
        if (lo.domain === 'string' || lo.domain === 'boolean')
          return { kind: 'unknown' };
        if (!join(lo.domain)) return { kind: 'unknown' };
        intervals.push({
          lo: lo.value as number,
          hi: hi.value as number,
          loClosed: open === '[',
          hiClosed: close === ']',
        });
        continue;
      }
      if (first && !second && !third) {
        const v = read(first);
        if (!v) return { kind: 'unknown' };
        if (!pushValue(v)) return { kind: 'unknown' };
        continue;
      }
      return { kind: 'unknown' };
    }
    const v = read(inner);
    if (!v || !pushValue(v)) return { kind: 'unknown' };
  }
  function pushValue(v: { domain: string; value: number | string }) {
    if (!join(v.domain)) return false;
    if (v.domain === 'number' || v.domain === 'date') {
      const x = v.value as number;
      intervals.push({ lo: x, hi: x, loClosed: true, hiClosed: true });
    } else values.push(String(v.value));
    return true;
  }
  if (!domain) return { kind: 'unknown' };
  if (domain === 'string' || domain === 'boolean')
    return { kind: 'values', domain, values, negated };
  if (negated) return { kind: 'unknown' };
  return { kind: 'numbers', domain: domain as 'number' | 'date', intervals };
}

function literal(
  n: SyntaxNode,
  text: string,
):
  | { domain: 'number' | 'date' | 'string' | 'boolean'; value: number | string }
  | undefined {
  const s = text.slice(n.from, n.to);
  if (n.name === 'NumericLiteral')
    return { domain: 'number', value: Number(s) };
  if (n.name === 'StringLiteral')
    return { domain: 'string', value: unquote(s) };
  if (n.name === 'BooleanLiteral') return { domain: 'boolean', value: s };
  if (n.name === 'DateTimeLiteral') {
    const m = /^date\s*\(\s*"(\d{4})-(\d{2})-(\d{2})"\s*\)$/.exec(s);
    if (!m) return undefined;
    const day =
      Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
    return { domain: 'date', value: day };
  }
  // A negative number: `-5` is ArithmeticExpression(ArithOp, NumericLiteral).
  if (n.name === 'ArithmeticExpression') {
    const [op, num] = kids(n);
    if (
      op?.name === 'ArithOp' &&
      text.slice(op.from, op.to) === '-' &&
      num?.name === 'NumericLiteral' &&
      kids(n).length === 2
    )
      return { domain: 'number', value: -Number(text.slice(num.from, num.to)) };
  }
  return undefined;
}

function kids(n: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = n.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}
