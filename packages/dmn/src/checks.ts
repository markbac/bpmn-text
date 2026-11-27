import { diagnostic, type Diagnostic } from '@bpmn-text/core';
import type { EntryMeaning, Interval } from './feel.js';
import type { DecisionTable, DmnModel } from './model.js';

/** Beyond this many uncovered boxes, the gap check gives up rather than guess. */
const MAX_BOXES = 4000;

/**
 * Checks every decision table for overlapping rules (BT530), input
 * combinations no rule covers (BT531) and rules that can never be chosen
 * under `first` (BT532). Entries the checks cannot reason about are
 * skipped, never guessed.
 */
export function checkTables(
  model: DmnModel,
  entries: Map<string, EntryMeaning>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const e of model.elements) {
    if (e.kind !== 'decision' || e.logic?.type !== 'table') continue;
    checkTable(e.logic, entries, diagnostics);
  }
  return diagnostics;
}

/** One input column, cut into segments that every rule covers whole. */
interface Column {
  name: string;
  segments: Segment[];
  /** All segments. */
  full: bigint;
  /** The segments the gap check must see covered. */
  listedOnly: bigint;
}

type Segment =
  | { kind: 'point'; value: number; domain: 'number' | 'date' }
  | {
      kind: 'gap';
      lo: number;
      hi: number;
      domain: 'number' | 'date';
    }
  | {
      kind: 'value';
      value: string;
      domain: 'string' | 'boolean';
      /** Any value not listed. */
      other?: boolean;
    };

/** A rule's region: one segment set per column. Undefined: unknown. */
type Box = bigint[];

function checkTable(
  t: DecisionTable,
  entries: Map<string, EntryMeaning>,
  diagnostics: Diagnostic[],
) {
  if (!t.inputs.length || !t.outputs.length || !t.rules.length) return;
  const meanings = t.rules.map((r) =>
    t.inputs.map(
      (_, c): EntryMeaning =>
        entries.get(r.inputEntries[c]?.id ?? '') ?? { kind: 'unknown' },
    ),
  );
  const columns = t.inputs.map((input, c) =>
    column(
      input.expression,
      meanings.map((m) => m[c]!),
      input.values,
    ),
  );
  const boxes: (Box | undefined)[] = meanings.map((row) => {
    const box: Box = [];
    for (let c = 0; c < row.length; c++) {
      const mask = toMask(row[c]!, columns[c]);
      if (mask === undefined) return undefined;
      box.push(mask);
    }
    return box;
  });

  // Overlaps.
  if (t.hitPolicy === 'UNIQUE' || t.hitPolicy === 'ANY') {
    for (let j = 1; j < boxes.length; j++) {
      const b = boxes[j];
      if (!b) continue;
      for (let i = 0; i < j; i++) {
        const a = boxes[i];
        if (!a) continue;
        const common = intersect(a, b);
        if (!common) continue;
        if (t.hitPolicy === 'ANY') {
          const out = (k: number) =>
            t.rules[k]!.outputEntries.map((o) => o.text.replace(/\s+/g, ' '));
          if (out(i).join('\u0000') === out(j).join('\u0000')) continue;
        }
        const where = region(common, columns as Column[]);
        const why =
          t.hitPolicy === 'UNIQUE'
            ? 'under `unique` at most one rule may match'
            : 'under `any` rules that match together must give the same output';
        const [ri, rj] = [t.rules[i]!, t.rules[j]!];
        diagnostics.push(
          diagnostic(
            'BT530',
            `Rules ${ri.index} and ${rj.index} both match ${where}, but ${why}.`,
            rj.range,
            { related: [{ message: `Rule ${ri.index}`, range: ri.range }] },
          ),
          diagnostic(
            'BT530',
            `Rules ${ri.index} and ${rj.index} both match ${where}, but ${why}.`,
            ri.range,
            { related: [{ message: `Rule ${rj.index}`, range: rj.range }] },
          ),
        );
      }
    }
  }

  // Rules that can never be chosen under `first`.
  if (t.hitPolicy === 'FIRST') {
    for (let j = 1; j < boxes.length; j++) {
      const b = boxes[j];
      if (!b) continue;
      const earlier = boxes
        .slice(0, j)
        .map((a, i) => ({ a, i }))
        .filter(
          (x): x is { a: Box; i: number } => !!x.a && !!intersect(x.a, b),
        );
      if (!earlier.length) continue;
      const left = subtractAll(
        [b],
        earlier.map((x) => x.a),
      );
      if (left && left.length === 0) {
        const by = earlier.map((x) => t.rules[x.i]!.index);
        diagnostics.push(
          diagnostic(
            'BT532',
            `Rule ${t.rules[j]!.index} can never be chosen: ${by.length === 1 ? `rule ${by[0]} matches everything it matches, and comes` : `rules ${list(by)} match everything it matches, and come`} first.`,
            t.rules[j]!.range,
          ),
        );
      }
    }
  }

  // Gaps, only when every rule could be read.
  if (boxes.every((b) => b) && columns.every((c) => c)) {
    const full = (columns as Column[]).map((c) => c.listedOnly);
    const left = subtractAll([full], boxes as Box[]);
    if (left && left.length) {
      const box = left[0]!;
      const constrained = (columns as Column[])
        .map((c, k) => ({ c, mask: box[k]! }))
        .filter(({ c, mask }) => mask !== c.listedOnly && mask !== c.full);
      const where = constrained
        .map(({ c, mask }) => `${c.name} ${describe(mask, c)}`)
        .join(' and ');
      // An example helps where the region is a range or a list.
      const example = constrained.some(({ mask }) => mask & (mask - 1n))
        ? `, such as ${constrained
            .map(
              ({ c, mask }) =>
                `${c.name} = ${represent(c.segments[lowest(mask)]!)}`,
            )
            .join(' and ')}`
        : '';
      const more =
        left.length > 1 ? ' Other inputs are not covered either.' : '';
      diagnostics.push(
        diagnostic(
          'BT531',
          `No rule matches ${where || 'any input'}${example}.${more} Add a rule for it, or a last rule with \`-\` in every input column.`,
          t.keywordRange,
        ),
      );
    }
  }
}

/**
 * Cuts a column into segments, or undefined when its entries mix types
 * (then nothing in it can be reasoned about).
 */
function column(
  name: string,
  meanings: EntryMeaning[],
  allowed: string | undefined,
): Column | undefined {
  const domains = new Set(
    meanings.flatMap((m) =>
      m.kind === 'numbers' || m.kind === 'values' ? [m.domain] : [],
    ),
  );
  if (domains.size > 1) return undefined;
  const domain = [...domains][0] ?? 'string';
  const segments: Segment[] = [];
  if (domain === 'number' || domain === 'date') {
    const points = [
      ...new Set(
        meanings.flatMap((m) =>
          m.kind === 'numbers'
            ? m.intervals.flatMap((i) => [i.lo, i.hi].filter(Number.isFinite))
            : [],
        ),
      ),
    ].sort((a, b) => a - b);
    let lo = -Infinity;
    for (const p of points) {
      if (domain === 'number' || p - lo > 1)
        segments.push({ kind: 'gap', lo, hi: p, domain });
      segments.push({ kind: 'point', value: p, domain });
      lo = p;
    }
    segments.push({ kind: 'gap', lo, hi: Infinity, domain });
  } else {
    let values: string[];
    const listed = allowed ? enumerated(allowed) : undefined;
    if (domain === 'boolean') values = ['true', 'false'];
    else if (listed) values = listed;
    else
      values = [
        ...new Set(
          meanings.flatMap((m) => (m.kind === 'values' ? m.values : [])),
        ),
      ];
    for (const v of values)
      segments.push({ kind: 'value', value: v, domain: domain as 'string' });
    // Strings not listed: what `not(…)` and `-` match besides the listed ones.
    if (domain === 'string' && !listed)
      segments.push({
        kind: 'value',
        value: '',
        domain: 'string',
        other: true,
      });
  }
  const full = (1n << BigInt(segments.length)) - 1n;
  // The gap check leaves out unlisted strings: a table that lists values
  // without a catch-all is not missing a rule for every other string.
  const other = segments.findIndex((s) => s.kind === 'value' && s.other);
  const listedOnly =
    other === -1 || segments.length === 1
      ? full
      : full & ~(1n << BigInt(other));
  return { name, segments, full, listedOnly };
}

/** The values of a column's `in "a", "b"` list, if they are plain strings. */
function enumerated(allowed: string): string[] | undefined {
  const parts = allowed.split(',').map((p) => p.trim());
  if (!parts.every((p) => /^"(?:[^"\\]|\\.)*"$/.test(p))) return undefined;
  return parts.map((p) => JSON.parse(p) as string);
}

function toMask(m: EntryMeaning, c: Column | undefined): bigint | undefined {
  if (!c || m.kind === 'unknown') return undefined;
  if (m.kind === 'any') return c.full;
  let mask = 0n;
  c.segments.forEach((s, k) => {
    let inside = false;
    if (m.kind === 'numbers' && s.kind !== 'value')
      inside = m.intervals.some((i) => contains(i, s));
    else if (m.kind === 'values' && s.kind === 'value')
      inside = m.values.includes(s.value) !== m.negated;
    if (inside) mask |= 1n << BigInt(k);
  });
  return mask;
}

function contains(i: Interval, s: Segment): boolean {
  if (s.kind === 'point')
    return (
      (i.lo < s.value || (i.lo === s.value && i.loClosed)) &&
      (s.value < i.hi || (s.value === i.hi && i.hiClosed))
    );
  if (s.kind === 'gap') return i.lo <= s.lo && s.hi <= i.hi;
  return false;
}

function intersect(a: Box, b: Box): Box | undefined {
  const out: Box = [];
  for (let k = 0; k < a.length; k++) {
    const m = a[k]! & b[k]!;
    if (m === 0n) return undefined;
    out.push(m);
  }
  return out;
}

/** `boxes` minus each of `cut`, or undefined beyond MAX_BOXES. */
function subtractAll(boxes: Box[], cut: Box[]): Box[] | undefined {
  let left = boxes;
  for (const c of cut) {
    const next: Box[] = [];
    for (const b of left) {
      if (!intersect(b, c)) {
        next.push(b);
        continue;
      }
      // Peel off, dimension by dimension, what lies outside `c`.
      const rest = [...b];
      for (let k = 0; k < b.length; k++) {
        const outside = rest[k]! & ~c[k]!;
        if (outside !== 0n) {
          const piece = [...rest];
          piece[k] = outside;
          next.push(piece);
        }
        rest[k] = rest[k]! & c[k]!;
      }
    }
    if (next.length > MAX_BOXES) return undefined;
    left = next;
  }
  return left;
}

function lowest(mask: bigint): number {
  let k = 0;
  while (((mask >> BigInt(k)) & 1n) === 0n) k++;
  return k;
}

const day = (d: number) => {
  const date = new Date(d * 86400000);
  return `date("${date.toISOString().slice(0, 10)}")`;
};

/** An example value in a segment. */
function represent(s: Segment): string {
  const show = (x: number) => (s.domain === 'date' ? day(x) : fmt(x));
  if (s.kind === 'value')
    return s.other
      ? 'any value'
      : s.domain === 'string'
        ? JSON.stringify(s.value)
        : s.value;
  if (s.kind === 'point') return show(s.value);
  if (s.lo === -Infinity && s.hi === Infinity) return show(0);
  if (s.lo === -Infinity) return show(s.hi - 1);
  if (s.hi === Infinity) return show(s.lo + 1);
  return show(s.domain === 'date' ? s.lo + 1 : (s.lo + s.hi) / 2);
}

const fmt = (x: number) => String(Math.round(x * 1e6) / 1e6);

/** The region two rules share, as text: `Credit score in [700..750)`. */
function region(box: Box, columns: Column[]): string {
  const parts = box
    .map((mask, k) => {
      const c = columns[k];
      if (!c || mask === c.full) return undefined;
      return `${c.name} ${describe(mask, c)}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(' and ') : 'every input';
}

/** A segment set as FEEL-like text. */
function describe(mask: bigint, c: Column): string {
  const on = c.segments.map((_, k) => ((mask >> BigInt(k)) & 1n) === 1n);
  const first = c.segments[0];
  if (first?.kind === 'value') {
    const values = c.segments.filter((_, k) => on[k]).map((s) => represent(s));
    return values.length === 1 ? `= ${values[0]}` : `in ${values.join(', ')}`;
  }
  // Runs of consecutive segments are intervals.
  const runs: string[] = [];
  for (let k = 0; k < on.length; k++) {
    if (!on[k]) continue;
    let end = k;
    while (end + 1 < on.length && on[end + 1]) end++;
    runs.push(run(c.segments[k]!, c.segments[end]!));
    k = end;
  }
  return runs.length === 1 &&
    !runs[0]!.startsWith('[') &&
    !runs[0]!.startsWith('(')
    ? runs[0]!
    : `in ${runs.join(', ')}`;
}

function run(from: Segment, to: Segment): string {
  if (from.kind === 'value' || to.kind === 'value') return '';
  const show = (x: number) => (from.domain === 'date' ? day(x) : fmt(x));
  const lo = from.kind === 'point' ? from.value : from.lo;
  const hi = to.kind === 'point' ? to.value : to.hi;
  const loClosed = from.kind === 'point';
  const hiClosed = to.kind === 'point';
  if (lo === hi) return `= ${show(lo)}`;
  if (lo === -Infinity) return `${hiClosed ? '<=' : '<'} ${show(hi)}`;
  if (hi === Infinity) return `${loClosed ? '>=' : '>'} ${show(lo)}`;
  return `${loClosed ? '[' : '('}${show(lo)}..${show(hi)}${hiClosed ? ']' : ')'}`;
}

const list = (n: number[]) =>
  n.length === 1
    ? String(n[0])
    : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
