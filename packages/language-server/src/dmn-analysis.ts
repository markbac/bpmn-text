import type { Range, Suggestion } from '@bpmn-text/core';
import {
  dmnReferenceText,
  formatDmn,
  parseDmn,
  suggestDmn,
  type DmnDocument,
  type ElementStmt,
} from '@bpmn-text/dmn';
import type { Span } from './analysis.js';

/**
 * Editor features for `.dmnt` (#82), on source text and offsets, as
 * `analysis.ts` does for `.bpmnt`.
 */

const span = (r: Range): Span => ({ start: r.start.offset, end: r.end.offset });
const within = (s: Span, offset: number) =>
  offset >= s.start && offset <= s.end;

export type DmnSymbolKind =
  'decision' | 'input' | 'knowledge' | 'source' | 'logic';

export interface DmnSymbol {
  name: string;
  detail: string;
  kind: DmnSymbolKind;
  range: Span;
  selection: Span;
  children: DmnSymbol[];
}

const KIND_NAME = {
  decision: 'Decision',
  input: 'Input data',
  knowledge: 'Business knowledge model',
  source: 'Knowledge source',
} as const;

/** A use of an element's name: in `requires`, or as a table heading. */
interface Use {
  name: string;
  range: Span;
  where: 'requires' | 'heading';
}

interface DmnIndex {
  ast: DmnDocument;
  elements: ElementStmt[];
  uses: Use[];
}

function index(source: string): DmnIndex {
  const { ast } = parseDmn(source);
  const uses: Use[] = [];
  const names = new Set(ast.elements.map((e) => e.name.value));
  for (const e of ast.elements) {
    for (const a of e.attrs) {
      if (a.key.value !== 'requires') continue;
      for (const v of a.values)
        uses.push({ name: v.value, range: span(v.range), where: 'requires' });
    }
    for (const l of e.logic) {
      if (l.type !== 'table') continue;
      for (const c of l.columns) {
        if (c.role === 'input' && names.has(c.label.value))
          uses.push({
            name: c.label.value,
            range: span(c.label.range),
            where: 'heading',
          });
      }
    }
  }
  return { ast, elements: ast.elements, uses };
}

/** The element named at `offset`: its declaration, or a use of its name. */
function at(idx: DmnIndex, offset: number) {
  for (const e of idx.elements) {
    if (within(span(e.name.range), offset))
      return { element: e, range: span(e.name.range), declaration: true };
  }
  const use = idx.uses.find((u) => within(u.range, offset));
  if (!use) return undefined;
  const element = idx.elements.find((e) => e.name.value === use.name);
  return element && { element, range: use.range, declaration: false };
}

export function dmnDefinition(source: string, offset: number): Span[] {
  const hit = at(index(source), offset);
  return hit && !hit.declaration ? [span(hit.element.name.range)] : [];
}

export function dmnReferences(source: string, offset: number): Span[] {
  const idx = index(source);
  const hit = at(idx, offset);
  if (!hit) return [];
  return [
    span(hit.element.name.range),
    ...idx.uses
      .filter((u) => u.name === hit.element.name.value)
      .map((u) => u.range),
  ];
}

/** Markdown for an element: its kind, type, requirements and documentation. */
export function dmnHover(
  source: string,
  offset: number,
): { range: Span; markdown: string } | undefined {
  const idx = index(source);
  const hit = at(idx, offset);
  if (hit) {
    const e = hit.element;
    const attr = (k: string) =>
      e.attrs.find((a) => a.key.value === k)?.values.map((v) => v.value);
    const lines = [`**${KIND_NAME[e.kind]}** ${e.name.value}`];
    const type = attr('type');
    if (type) lines.push(`Type: \`${type.join(', ')}\``);
    const values = attr('values');
    if (values)
      lines.push(`Values: ${values.map((v) => `\`${v}\``).join(', ')}`);
    const requires = attr('requires');
    if (requires) lines.push(`Requires: ${requires.join(', ')}`);
    const logic = e.logic[0];
    if (logic?.type === 'table') {
      const hit = logic.attrs.find((a) => a.key.value === 'hit');
      lines.push(
        `Decision table, ${logic.rows.length} rule${logic.rows.length === 1 ? '' : 's'}, hit policy ${hit?.values.map((v) => v.value).join(', ') ?? 'unique'}`,
      );
    } else if (logic?.type === 'literal') lines.push('Literal expression');
    const doc = [...(attr('doc') ?? []), ...e.docs.map((d) => d.text)].join(
      '\n\n',
    );
    if (doc) lines.push('', doc);
    return { range: hit.range, markdown: lines.join('\n\n') };
  }
  // A table heading: the column's role and type.
  for (const e of idx.elements) {
    for (const l of e.logic) {
      if (l.type !== 'table') continue;
      const c = l.columns.find((col) => within(span(col.range), offset));
      if (!c) continue;
      const role =
        c.role === 'input'
          ? 'Input'
          : c.role === 'output'
            ? 'Output'
            : 'Annotations';
      const named = idx.elements.find((x) => x.name.value === c.label.value);
      const type =
        c.typeRef?.value ??
        named?.attrs.find((a) => a.key.value === 'type')?.values[0]?.value;
      const lines = [`**${role} column** ${c.label.value}`];
      if (type) lines.push(`Type: \`${type}\``);
      if (c.values) lines.push(`Values: \`${c.values.value}\``);
      return { range: span(c.range), markdown: lines.join('\n\n') };
    }
  }
  return undefined;
}

export function dmnSymbols(source: string): DmnSymbol[] {
  return index(source).elements.map((e) => ({
    name: e.name.value,
    detail: KIND_NAME[e.kind],
    kind: e.kind,
    range: span(e.range),
    selection: span(e.name.range),
    children: e.logic.map((l) => ({
      name: l.type === 'table' ? 'table' : 'literal',
      detail:
        l.type === 'table'
          ? `${l.rows.length} rule${l.rows.length === 1 ? '' : 's'}`
          : l.text.split('\n')[0]!,
      kind: 'logic' as const,
      range: span(l.range),
      selection: span(l.keyword.range),
      children: [],
    })),
  }));
}

export function dmnComplete(
  source: string,
  offset: number,
): { from: number; options: Suggestion[] } | undefined {
  const start = source.lastIndexOf('\n', offset - 1) + 1;
  const previousStart =
    start > 0 ? source.lastIndexOf('\n', start - 2) + 1 : start;
  const previous = start > 0 ? source.slice(previousStart, start - 1) : '';
  const names = parseDmn(source).ast.elements.map((e) => e.name.value);
  const result = suggestDmn(source.slice(start, offset), { names }, previous);
  return result && { from: start + result.from, options: result.options };
}

export function dmnFormatted(source: string): string | undefined {
  const result = formatDmn(source);
  return result === source ? undefined : result;
}

/** Renames an element, its requirements and the headings that read it. */
export function dmnRename(
  source: string,
  offset: number,
  newName: string,
):
  | {
      range: Span;
      placeholder: string;
      edits: { range: Span; newText: string }[];
      error?: string;
    }
  | undefined {
  const idx = index(source);
  const hit = at(idx, offset);
  if (!hit) return undefined;
  const old = hit.element.name.value;
  const result = {
    range: hit.range,
    placeholder: old,
    edits: [] as { range: Span; newText: string }[],
  };
  const name = newName.trim();
  if (!newName) return result;
  if (!name) return { ...result, error: 'A name cannot be empty.' };
  if (name !== old && idx.elements.some((e) => e.name.value === name))
    return {
      ...result,
      error: `Another element is already called \`${name}\`.`,
    };
  const declared =
    hit.element.name.quoted || dmnReferenceText(name) !== name
      ? JSON.stringify(name)
      : name;
  result.edits.push({ range: span(hit.element.name.range), newText: declared });
  for (const u of idx.uses.filter((x) => x.name === old)) {
    result.edits.push({
      range: u.range,
      newText:
        u.where === 'heading'
          ? name.replace(/\|/g, '\\|')
          : dmnReferenceText(name),
    });
  }
  return result;
}

/** The decision a BPMN `[decision: …]` names at `offset`, if any. */
export function decisionAt(
  bpmnSource: string,
  offset: number,
): { name: string; file?: string; range: Span } | undefined {
  const re = /\[[^\]]*?\bdecision:\s*([^,\]]+)/g;
  for (const m of bpmnSource.matchAll(re)) {
    const value = m[1]!.trimEnd();
    const start = m.index! + m[0].length - m[1]!.length;
    const s = { start, end: start + value.length };
    if (!within(s, offset)) continue;
    const hash = value.lastIndexOf('#');
    return hash > 0
      ? {
          name: value.slice(hash + 1).trim(),
          file: value.slice(0, hash).trim(),
          range: s,
        }
      : { name: value, range: s };
  }
  return undefined;
}

/** Where decision `name` is declared in `.dmnt` source, if it is. */
export function decisionDeclaration(
  dmnSource: string,
  name: string,
): Span | undefined {
  const e = parseDmn(dmnSource).ast.elements.find(
    (x) => x.kind === 'decision' && x.name.value === name,
  );
  return e && span(e.name.range);
}

/** The decisions declared in `.dmnt` source. */
export function decisionNames(dmnSource: string): string[] {
  return parseDmn(dmnSource).ast.elements.flatMap((e) =>
    e.kind === 'decision' ? [e.name.value] : [],
  );
}
