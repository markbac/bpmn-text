import {
  format,
  parse,
  referenceText,
  suggest,
  type Attr,
  type Branch,
  type BoundaryStmt,
  type CompletionData,
  type ElementDecl,
  type FlowStep,
  type Range,
  type Statement,
  type Suggestion,
  type Text,
} from '@bpmn-text/core';

/**
 * Everything the language server answers, as plain functions over the
 * source text and character offsets. The server (`server.ts`) only
 * converts between offsets and LSP positions.
 */

export interface Span {
  start: number;
  end: number;
}

const span = (r: Range): Span => ({
  start: r.start.offset,
  end: r.end.offset,
});

const within = (s: Span, offset: number) =>
  offset >= s.start && offset <= s.end;

/** Names match as the compiler matches them (notation §6.2). */
const normalise = (name: string) =>
  name.trim().replace(/\s+/g, ' ').toLowerCase();

export type SymbolKind =
  'pool' | 'lane' | 'element' | 'subprocess' | 'group' | 'data';

export interface DocumentSymbol {
  name: string;
  detail: string;
  kind: SymbolKind;
  /** The whole statement. */
  range: Span;
  /** The name, which the editor highlights. */
  selection: Span;
  children: DocumentSymbol[];
}

interface Declaration {
  kind: string;
  name?: Text | undefined;
  id?: Text | undefined;
  lane?: string | undefined;
  documentation?: string | undefined;
  /** What the name resolves for: a node or pool, a lane, or data. */
  namespace: Namespace;
}

type Namespace = 'node' | 'lane' | 'data';

interface Reference {
  name?: Text;
  id?: Text;
  namespace: Namespace;
}

export interface Index {
  symbols: DocumentSymbol[];
  declarations: Declaration[];
  references: Reference[];
}

const text = (t: Text | undefined) => t?.value ?? '';

/** Data names written with a state, whose `(state)` follows the name. */
const withState = new WeakSet<Text>();

/** `Name (state)`, as the compiler reads a data name. */
const STATE = /^(.*\S)\s*\(\s*[^()]*[^()\s]\s*\)$/;

/** IDs as the lexer reads them. */
const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * The data object a data name refers to: `Invoice (draft)` is `Invoice`
 * in state `draft`, and the name covers `Invoice` only. A quoted name keeps
 * its brackets (notation §4.4), as the compiler reads it.
 */
function dataText(t: Text): Text {
  const m = t.quoted ? null : STATE.exec(t.value);
  if (!m) return t;
  const length = m[1]!.length;
  const name: Text = {
    value: m[1]!,
    quoted: false,
    range: {
      start: t.range.start,
      end: {
        line: t.range.start.line,
        col: t.range.start.col + length,
        offset: t.range.start.offset + length,
      },
    },
  };
  withState.add(name);
  return name;
}

/** Lays out a document: its symbols, declarations and references. */
export function index(source: string): Index {
  const { ast } = parse(source);
  const result: Index = { symbols: [], declarations: [], references: [] };

  const declare = (d: Declaration) => result.declarations.push(d);
  const refer = (r: Reference) => result.references.push(r);

  const attrs = (list: Attr[]) => {
    for (const a of list) {
      if (a.key.value === 'lane') {
        for (const v of a.values) refer({ name: v, namespace: 'lane' });
      } else if (a.key.value === 'reads' || a.key.value === 'writes') {
        for (const v of a.values)
          refer({ name: dataText(v), namespace: 'data' });
      }
    }
    return list.find((a) => a.key.value === 'lane')?.values[0]?.value;
  };

  const element = (
    e: ElementDecl,
    out: DocumentSymbol[],
    lane: string | undefined,
    range: Range,
  ): DocumentSymbol | undefined => {
    const own = attrs(e.attrs) ?? lane;
    const doc = e.attrs.find((a) => a.key.value === 'doc')?.values[0]?.value;
    if (e.name || e.id) {
      declare({
        kind: e.kind,
        name: e.name,
        id: e.id,
        lane: own,
        documentation: doc,
        namespace: 'node',
      });
    }
    if (!e.name) return undefined;
    const symbol: DocumentSymbol = {
      name: e.name.value,
      detail: e.kind,
      kind: e.kind === 'sub' ? 'subprocess' : 'element',
      range: span(range),
      selection: span(e.name.range),
      children: [],
    };
    out.push(symbol);
    return symbol;
  };

  const steps = (
    tail: FlowStep[],
    out: DocumentSymbol[],
    lane: string | undefined,
  ) => {
    for (const step of tail) {
      for (const target of step.targets) {
        if (target.type === 'ref') refer({ ...target, namespace: 'node' });
        else element(target, out, lane, target.range);
      }
    }
  };

  const branch = (
    b: Branch,
    out: DocumentSymbol[],
    lane: string | undefined,
  ) => {
    if (b.inline) {
      const t = b.inline.target;
      if (t.type === 'ref') refer({ ...t, namespace: 'node' });
      else element(t, out, lane, t.range);
      steps(b.inline.tail, out, lane);
    }
    body(b.body, out, lane);
  };

  const boundary = (
    b: BoundaryStmt,
    out: DocumentSymbol[],
    lane: string | undefined,
  ) => {
    attrs(b.element.attrs);
    steps(b.tail, out, lane);
    body(b.body, out, lane);
  };

  const body = (
    list: Statement[],
    out: DocumentSymbol[],
    inherited: string | undefined,
  ) => {
    let lane = inherited;
    for (const s of list) {
      switch (s.type) {
        case 'pool': {
          const symbol: DocumentSymbol = {
            name: s.name.value,
            detail: 'pool',
            kind: 'pool',
            range: span(s.range),
            selection: span(s.name.range),
            children: [],
          };
          out.push(symbol);
          declare({ kind: 'pool', name: s.name, namespace: 'node' });
          attrs(s.attrs);
          if (s.body) body(s.body, symbol.children, undefined);
          break;
        }
        case 'lane':
          lane = s.name.value;
          declare({ kind: 'lane', name: s.name, namespace: 'lane' });
          out.push({
            name: s.name.value,
            detail: 'lane',
            kind: 'lane',
            range: span(s.range),
            selection: span(s.name.range),
            children: [],
          });
          break;
        case 'lanes':
          for (const l of s.lanes) {
            declare({ kind: 'lane', name: l.name, namespace: 'lane' });
            out.push({
              name: l.name.value,
              detail: 'lane',
              kind: 'lane',
              range: span(l.range),
              selection: span(l.name.range),
              children: [],
            });
          }
          break;
        case 'element-stmt': {
          element(s.element, out, lane, s.range);
          steps(s.tail, out, lane);
          for (const b of s.boundaries) boundary(b, out, lane);
          break;
        }
        case 'gateway': {
          const symbol = element(s.element, out, lane, s.range);
          for (const b of s.branches ?? [])
            branch(b, symbol?.children ?? out, lane);
          break;
        }
        case 'fork':
          for (const b of s.branches) branch(b, out, lane);
          break;
        case 'sub': {
          const symbol = element(s.element, out, lane, s.range);
          if (s.body) body(s.body, symbol?.children ?? out, lane);
          for (const b of s.boundaries) boundary(b, out, lane);
          break;
        }
        case 'group': {
          const symbol: DocumentSymbol = {
            name: s.name.value,
            detail: 'group',
            kind: 'group',
            range: span(s.range),
            selection: span(s.name.range),
            children: [],
          };
          out.push(symbol);
          body(s.body, symbol.children, lane);
          break;
        }
        case 'goto':
          steps(s.tail, out, lane);
          break;
        case 'message':
          refer({ ...s.source, namespace: 'node' });
          steps([s.step], out, lane);
          break;
        case 'data':
          out.push({
            name: s.name.value,
            detail: s.kind,
            kind: 'data',
            range: span(s.range),
            selection: span(s.name.range),
            children: [],
          });
          declare({ kind: s.kind, name: dataText(s.name), namespace: 'data' });
          break;
        case 'note':
        case 'doc':
          break;
      }
    }
  };

  body(ast.body, result.symbols, undefined);
  return result;
}

const matches = (d: Declaration, r: Reference) => {
  if (d.namespace !== r.namespace) return false;
  if (r.id) return d.id?.value === r.id.value;
  return (
    !!r.name && !!d.name && normalise(d.name.value) === normalise(r.name.value)
  );
};

/** A declaration or reference under the cursor, and where its name is. */
function at(idx: Index, offset: number) {
  for (const d of idx.declarations) {
    if (d.name && within(span(d.name.range), offset))
      return { declaration: d, text: d.name };
    if (d.id && within(span(d.id.range), offset))
      return { declaration: d, text: d.id };
  }
  for (const r of idx.references) {
    const t = r.id && within(span(r.id.range), offset) ? r.id : r.name;
    if (t && within(span(t.range), offset)) return { reference: r, text: t };
  }
  return undefined;
}

/** The declarations the name or ID at `offset` refers to. */
function targets(idx: Index, offset: number): Declaration[] {
  const hit = at(idx, offset);
  if (!hit) return [];
  const declaration = hit.declaration;
  if (!declaration) {
    return idx.declarations.filter((d) => matches(d, hit.reference!));
  }
  // A data object can be declared once per state.
  if (declaration.namespace !== 'data' || !declaration.name)
    return [declaration];
  const name = declaration.name;
  return idx.declarations.filter(
    (d) => d === declaration || matches(d, { name, namespace: 'data' }),
  );
}

/** Go to definition: a reference's declarations, or none off a name. */
export function definition(source: string, offset: number): Span[] {
  const idx = index(source);
  const found = idx.references.some(
    (r) =>
      (r.id && within(span(r.id.range), offset)) ||
      (r.name && within(span(r.name.range), offset)),
  );
  if (!found) return [];
  return targets(idx, offset).flatMap((d) =>
    d.name ? [span(d.name.range)] : d.id ? [span(d.id.range)] : [],
  );
}

/** Where the names and IDs of the declarations under `offset` appear. */
function occurrences(idx: Index, offset: number) {
  const decls = targets(idx, offset);
  const refs = idx.references.filter((r) => decls.some((d) => matches(d, r)));
  return { decls, refs };
}

/** Find references: every use of the element at `offset`, and its declaration. */
export function references(source: string, offset: number): Span[] {
  const idx = index(source);
  const { decls, refs } = occurrences(idx, offset);
  return [
    ...decls.flatMap((d) =>
      [d.name, d.id].flatMap((t) => (t ? [span(t.range)] : [])),
    ),
    ...refs.flatMap((r) => {
      const t = r.id ?? r.name;
      return t ? [span(t.range)] : [];
    }),
  ];
}

export interface Rename {
  /** The text being renamed, which the editor selects. */
  range: Span;
  placeholder: string;
  edits: { range: Span; newText: string }[];
  /** Why the new name cannot be used; there are no edits then. */
  error?: string;
}

/**
 * The edits that rename the name or ID at `offset`: its declaration and
 * every reference of the same kind. Undefined off a name or ID.
 */
export function rename(
  source: string,
  offset: number,
  to: string,
): Rename | undefined {
  const idx = index(source);
  const hit = at(idx, offset);
  if (!hit) return undefined;
  const byId =
    hit.text === hit.declaration?.id || hit.text === hit.reference?.id;
  const { decls, refs } = occurrences(idx, offset);
  const result = (edits: Rename['edits'], error?: string): Rename => ({
    range: span(hit.text.range),
    placeholder: hit.text.value,
    edits,
    ...(error === undefined ? {} : { error }),
  });
  const problem = renameProblem(idx, decls, refs, byId, to);
  if (problem) return result([], problem);
  const edits: Rename['edits'] = [];
  const replace = (t: Text) => {
    const newText = byId
      ? `@${to}`
      : t.quoted
        ? JSON.stringify(to)
        : referenceText(to);
    edits.push({ range: span(t.range), newText });
  };
  if (byId) {
    for (const d of decls) if (d.id) replace(d.id);
    for (const r of refs) if (r.id) replace(r.id);
  } else {
    for (const d of decls) if (d.name) replace(d.name);
    for (const r of refs) if (!r.id && r.name) replace(r.name);
  }
  return result(edits);
}

/** Why `to` cannot replace the names or IDs being renamed, if it cannot. */
function renameProblem(
  idx: Index,
  decls: Declaration[],
  refs: Reference[],
  byId: boolean,
  to: string,
): string | undefined {
  if (byId) {
    if (!ID.test(to)) {
      return `\`@${to}\` is not an ID: use letters, digits, \`_\` and \`-\`, starting with a letter or \`_\`.`;
    }
    const taken = idx.declarations.some(
      (d) => d.id?.value === to && !decls.includes(d),
    );
    return taken ? `The ID \`@${to}\` is already used.` : undefined;
  }
  if (!to.trim()) return 'The new name is empty.';
  const namespace = decls[0]?.namespace ?? refs[0]?.namespace ?? 'node';
  const taken = idx.declarations.some(
    (d) =>
      d.namespace === namespace &&
      !decls.includes(d) &&
      !!d.name &&
      normalise(d.name.value) === normalise(to),
  );
  if (taken) {
    const what = { node: 'an element or pool', lane: 'a lane', data: 'data' };
    return `\`${to}\` is already the name of ${what[namespace]}.`;
  }
  if (namespace === 'data') {
    const texts = [...decls.map((d) => d.name), ...refs.map((r) => r.name)];
    const stated = texts.some((t) => t && withState.has(t));
    if (STATE.test(to))
      return `\`${to}\` would read as a data object with a state. Rename it without the brackets.`;
    if (stated && referenceText(to) !== to)
      return `\`${to}\` needs quotes, and a quoted name cannot have a state.`;
  }
  return undefined;
}

/** Markdown for the hover over an element: its type, lane and notes. */
export function hover(
  source: string,
  offset: number,
): { range: Span; markdown: string } | undefined {
  const idx = index(source);
  const hit = at(idx, offset);
  if (!hit) return undefined;
  const decl = hit.declaration ?? targets(idx, offset)[0];
  if (!decl) return undefined;
  const lines = [`**${decl.kind}** ${text(decl.name) || `@${text(decl.id)}`}`];
  if (decl.lane) lines.push(`Lane: ${decl.lane}`);
  if (decl.documentation) lines.push('', decl.documentation);
  return { range: span(hit.text.range), markdown: lines.join('\n\n') };
}

export function symbols(source: string): DocumentSymbol[] {
  return index(source).symbols;
}

/** Element and lane names, for completion. */
export function completionData(source: string): CompletionData {
  const idx = index(source);
  const names = new Set<string>();
  const lanes = new Set<string>();
  for (const d of idx.declarations) {
    if (!d.name) continue;
    if (d.namespace === 'lane') lanes.add(d.name.value);
    else if (d.namespace === 'node') names.add(d.name.value);
  }
  return { names: [...names], lanes: [...lanes] };
}

/** Completions at `offset`, from the line up to the cursor. */
export function complete(
  source: string,
  offset: number,
): { from: number; options: Suggestion[] } | undefined {
  const start = source.lastIndexOf('\n', offset - 1) + 1;
  const result = suggest(source.slice(start, offset), completionData(source));
  return result && { from: start + result.from, options: result.options };
}

/** The whole document, formatted. Undefined when it would not change. */
export function formatted(source: string): string | undefined {
  const result = format(source);
  return result === source ? undefined : result;
}
