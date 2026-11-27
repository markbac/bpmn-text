import {
  diagnostic,
  didYouMean,
  normaliseColour,
  slug,
  type Diagnostic,
  type DiagnosticCode,
  type QuickFix,
  type Range,
  type Style,
  type Text,
} from '@bpmn-text/core';
import type {
  DmnAttr,
  DmnDocument,
  DmnKind,
  ElementStmt,
  LiteralStmt,
  TableStmt,
} from './ast.js';
import type {
  Decision,
  DecisionTable,
  DmnElement,
  DmnModel,
  DmnRule,
  InputClause,
  Knowledge,
  LiteralExpression,
  OutputClause,
  RequirementKind,
} from './model.js';
import { HIT_POLICIES, TYPES } from './parser.js';

/** A type, if it is one DMN knows; unknown ones are reported by the parser. */
const known = (type: string | undefined) =>
  type && (TYPES as readonly string[]).includes(type) ? type : undefined;

export interface DmnBuildResult {
  model: DmnModel;
  diagnostics: Diagnostic[];
}

const PREFIX: Record<DmnKind, string> = {
  decision: 'Decision',
  input: 'InputData',
  knowledge: 'BusinessKnowledgeModel',
  source: 'KnowledgeSource',
};

/** The attributes each kind of element takes (dmn-notation §2.1). */
const ATTRIBUTES: Record<DmnKind, string[]> = {
  input: ['type', 'values', 'id', 'doc', 'color', 'stroke'],
  decision: ['requires', 'type', 'id', 'doc', 'color', 'stroke'],
  knowledge: ['requires', 'type', 'params', 'id', 'doc', 'color', 'stroke'],
  source: ['requires', 'id', 'doc', 'color', 'stroke'],
};

const KIND_NAME: Record<DmnKind, string> = {
  input: 'input data',
  decision: 'a decision',
  knowledge: 'a knowledge model',
  source: 'a knowledge source',
};

/**
 * What a requirement from `to` on `from` is, or undefined if DMN does not
 * allow it (dmn-notation §3).
 */
function requirementKind(
  to: DmnKind,
  from: DmnKind,
): RequirementKind | undefined {
  if (to === 'decision') {
    if (from === 'decision' || from === 'input') return 'information';
    return from === 'knowledge' ? 'knowledge' : 'authority';
  }
  if (to === 'knowledge') {
    if (from === 'knowledge') return 'knowledge';
    return from === 'source' ? 'authority' : undefined;
  }
  if (to === 'source') return from === 'knowledge' ? undefined : 'authority';
  return undefined;
}

const REQUIREMENT_PREFIX: Record<RequirementKind, string> = {
  information: 'InformationRequirement',
  knowledge: 'KnowledgeRequirement',
  authority: 'AuthorityRequirement',
};

/** Builds the DMN model from the AST, resolving requirements. Never throws. */
export function buildDmn(ast: DmnDocument): DmnBuildResult {
  return new Builder().build(ast);
}

class Builder {
  readonly diagnostics: Diagnostic[] = [];
  private readonly ids = new Set<string>();

  private report(
    code: DiagnosticCode,
    message: string,
    range: Range,
    extra: Pick<Diagnostic, 'fixes' | 'related'> = {},
  ) {
    this.diagnostics.push(diagnostic(code, message, range, extra));
  }

  /** A unique ID from a prefix and a name, with `_2`, `_3` on clashes. */
  private id(prefix: string, name: string, slugged = false): string {
    const base = `${prefix}_${slugged ? name : slug(name)}`;
    let id = base;
    for (let n = 2; this.ids.has(id); n++) id = `${base}_${n}`;
    this.ids.add(id);
    return id;
  }

  build(ast: DmnDocument): DmnBuildResult {
    const name = ast.title?.value ?? 'Decisions';
    const model: DmnModel = {
      id: this.id('Definitions', name),
      name,
      elements: [],
      requirements: [],
    };
    const byName = new Map<
      string,
      { stmt: ElementStmt; element: DmnElement }
    >();
    // Explicit IDs first, so generated IDs step around them.
    for (const e of ast.elements) {
      if (!e.id) continue;
      if (this.ids.has(e.id.value))
        this.report(
          'BT203',
          `The ID \`@${e.id.value}\` is used twice.`,
          e.id.range,
        );
      this.ids.add(e.id.value);
    }
    for (const stmt of ast.elements) {
      const element = this.element(stmt);
      const key = stmt.name.value;
      const first = byName.get(key);
      if (first) {
        this.report(
          'BT510',
          `\`${key}\` is already the name of ${KIND_NAME[first.stmt.kind]}; names must be unique.`,
          stmt.name.range,
          {
            related: [
              { message: 'First declared here', range: first.stmt.name.range },
            ],
          },
        );
      } else byName.set(key, { stmt, element });
      model.elements.push(element);
    }
    // Requirements, once every name is known.
    const seen = new Set<string>();
    for (const stmt of ast.elements) {
      const to = byName.get(stmt.name.value);
      if (!to || to.stmt !== stmt || stmt.kind === 'input') continue;
      for (const attr of stmt.attrs.filter((a) => a.key.value === 'requires')) {
        for (const ref of attr.values) {
          const from = byName.get(ref.value);
          if (!from) {
            const suggestion = didYouMean(ref.value, byName.keys());
            this.report(
              'BT202',
              `Nothing is called \`${ref.value}\`.${suggestion ? ` Did you mean \`${suggestion}\`?` : ''}`,
              ref.range,
              suggestion ? { fixes: [rename(ref, suggestion)] } : {},
            );
            continue;
          }
          const kind = requirementKind(stmt.kind, from.stmt.kind);
          if (!kind) {
            this.report(
              'BT511',
              `${capital(KIND_NAME[stmt.kind])} cannot require ${KIND_NAME[from.stmt.kind]}.${
                stmt.kind === 'knowledge' && from.stmt.kind !== 'source'
                  ? ' A knowledge model gets its values from the decision that uses it.'
                  : ''
              }`,
              ref.range,
            );
            continue;
          }
          const key = `${from.element.id}->${to.element.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          model.requirements.push({
            id: this.id(
              REQUIREMENT_PREFIX[kind],
              `${slug(from.element.name)}__${slug(to.element.name)}`,
              true,
            ),
            kind,
            from: from.element.id,
            to: to.element.id,
            range: ref.range,
          });
        }
      }
    }
    // Tables last: their columns read the types of the inputs they name.
    for (const stmt of ast.elements) {
      const element = model.elements[ast.elements.indexOf(stmt)]!;
      this.logic(stmt, element, byName);
    }
    return { model, diagnostics: this.diagnostics };
  }

  private element(stmt: ElementStmt): DmnElement {
    const attr = (key: string) => stmt.attrs.find((a) => a.key.value === key);
    for (const a of stmt.attrs) {
      if (a.key.value === 'requires' && stmt.kind === 'input') {
        this.report(
          'BT511',
          'Input data cannot require anything.',
          a.key.range,
        );
      } else if (
        !ATTRIBUTES[stmt.kind].includes(a.key.value) &&
        ATTRIBUTES.decision
          .concat(ATTRIBUTES.input, ATTRIBUTES.knowledge, ['hit'])
          .includes(a.key.value)
      ) {
        this.report(
          'BT105',
          `\`${a.key.value}\` has no effect on ${KIND_NAME[stmt.kind]}.${a.key.value === 'hit' ? ' Put it on the `table`.' : ''}`,
          a.key.range,
        );
      }
    }
    const docs = [
      ...(attr('doc')?.values.map((v) => v.value) ?? []),
      ...stmt.docs.map((d) => d.text),
    ];
    const id = stmt.id?.value ?? this.id(PREFIX[stmt.kind], stmt.name.value);
    const base = {
      id,
      name: stmt.name.value,
      range: stmt.range,
      nameRange: stmt.name.range,
      ...(docs.length ? { doc: docs.join('\n\n') } : {}),
      ...this.style(stmt.attrs),
    };
    const typeRef = known(attr('type')?.values[0]?.value);
    const typed =
      typeRef && ATTRIBUTES[stmt.kind].includes('type') ? { typeRef } : {};
    switch (stmt.kind) {
      case 'decision':
        return { ...base, kind: 'decision', ...typed };
      case 'input': {
        const values = attr('values')?.values;
        return {
          ...base,
          kind: 'input',
          ...typed,
          ...(values?.length ? { values: feelList(values) } : {}),
        };
      }
      case 'knowledge':
        return {
          ...base,
          kind: 'knowledge',
          ...typed,
          params: (attr('params')?.values ?? []).map((p) => ({
            name: p.value,
            range: p.range,
          })),
        };
      case 'source':
        return { ...base, kind: 'source' };
    }
  }

  private style(attrs: DmnAttr[]): { style?: Style } {
    const style: Style = {};
    for (const a of attrs) {
      if (a.key.value !== 'color' && a.key.value !== 'stroke') continue;
      const written = a.values[0];
      if (!written) continue;
      const property = a.key.value === 'color' ? 'fill' : 'stroke';
      const colour = normaliseColour(written.value, property);
      if (!colour) {
        this.report(
          'BT104',
          `\`${written.value}\` is not a colour. Use #RRGGBB, #RGB, a palette name (blue, orange, green, red, purple) or a CSS colour name.`,
          written.range,
        );
        continue;
      }
      style[property] = colour;
    }
    return Object.keys(style).length ? { style } : {};
  }

  private logic(
    stmt: ElementStmt,
    element: DmnElement,
    byName: Map<string, { stmt: ElementStmt; element: DmnElement }>,
  ): void {
    const [first, ...more] = stmt.logic;
    if (!first) return;
    if (stmt.kind === 'input' || stmt.kind === 'source') {
      this.report(
        'BT517',
        `${capital(KIND_NAME[stmt.kind])} holds no logic; only decisions and knowledge models do.`,
        logicKeyword(first),
      );
      return;
    }
    for (const extra of more) {
      this.report(
        'BT517',
        `${capital(KIND_NAME[stmt.kind])} holds one table or one literal; this is a second.`,
        logicKeyword(extra),
      );
    }
    if (first.type === 'table' && stmt.kind === 'knowledge') {
      this.report(
        'BT517',
        'A knowledge model holds a literal here, not a table; put the table in a decision.',
        first.keyword.range,
      );
      return;
    }
    if (first.type === 'literal') {
      (element as Decision | Knowledge).logic = this.literal(element, first);
      return;
    }
    const decision = element as Decision;
    decision.logic = this.table(decision, first, byName);
    const outputs = decision.logic.outputs;
    if (!decision.typeRef && outputs.length === 1 && outputs[0]!.typeRef)
      decision.typeRef = outputs[0]!.typeRef;
  }

  private literal(element: DmnElement, stmt: LiteralStmt): LiteralExpression {
    return {
      type: 'literal',
      id: this.id(
        'LiteralExpression',
        element.id.slice(element.id.indexOf('_') + 1),
      ),
      text: stmt.text,
      lines: stmt.lines,
      range: stmt.range,
    };
  }

  private table(
    decision: Decision,
    stmt: TableStmt,
    byName: Map<string, { stmt: ElementStmt; element: DmnElement }>,
  ): DecisionTable {
    const base = decision.id.slice(decision.id.indexOf('_') + 1);
    const hit = stmt.attrs.find((a) => a.key.value === 'hit');
    for (const a of stmt.attrs)
      if (a.key.value !== 'hit')
        this.report(
          'BT105',
          `\`${a.key.value}\` has no effect on a table.`,
          a.key.range,
        );
    const policy =
      HIT_POLICIES[hit?.values.map((v) => v.value).join(', ') ?? 'unique'] ??
      HIT_POLICIES.unique!;
    const inputs: InputClause[] = [];
    const outputs: OutputClause[] = [];
    let annotation: string | undefined;
    stmt.columns.forEach((column) => {
      if (column.role === 'annotation') {
        annotation = column.label.value;
        return;
      }
      if (column.role === 'input') {
        const n = inputs.length + 1;
        const named = byName.get(column.label.value)?.element;
        const typeRef =
          known(column.typeRef?.value) ??
          (named && 'typeRef' in named ? named.typeRef : undefined);
        const values =
          column.values?.value ??
          (named?.kind === 'input' ? named.values : undefined);
        inputs.push({
          id: this.id('InputClause', `${base}_${n}`),
          expression: column.label.value,
          expressionId: this.id('InputExpression', `${base}_${n}`),
          ...(typeRef ? { typeRef } : {}),
          ...(values ? { values } : {}),
          range: column.range,
          expressionRange: column.label.range,
        });
        return;
      }
      const n = outputs.length + 1;
      outputs.push({
        id: this.id('OutputClause', `${base}_${n}`),
        name: column.label.value,
        ...(known(column.typeRef?.value)
          ? { typeRef: column.typeRef!.value }
          : {}),
        ...(column.values ? { values: column.values.value } : {}),
        range: column.range,
      });
    });
    if (outputs.length === 1 && !outputs[0]!.typeRef && decision.typeRef)
      outputs[0]!.typeRef = decision.typeRef;

    const rules: DmnRule[] = stmt.rows.map((row, r) => {
      const index = r + 1;
      const rule: DmnRule = {
        id: this.id('Rule', `${base}_${index}`),
        index,
        inputEntries: [],
        outputEntries: [],
        range: row.range,
      };
      stmt.columns.forEach((column, c) => {
        const cell = row.cells[c];
        if (!cell) return;
        if (column.role === 'annotation') {
          if (cell.text) rule.description = cell.text;
        } else if (column.role === 'input') {
          const i = rule.inputEntries.length + 1;
          rule.inputEntries.push({
            id: this.id('UnaryTests', `${base}_${index}_${i}`),
            text: cell.text || '-',
            range: cell.range,
          });
        } else {
          const o = rule.outputEntries.length + 1;
          rule.outputEntries.push({
            id: this.id('LiteralExpression', `${base}_${index}_${o}`),
            text: cell.text,
            range: cell.range,
          });
        }
      });
      return rule;
    });
    return {
      type: 'table',
      id: this.id('DecisionTable', base),
      hitPolicy: policy.hitPolicy,
      ...(policy.aggregation ? { aggregation: policy.aggregation } : {}),
      inputs,
      outputs,
      ...(annotation !== undefined ? { annotation } : {}),
      rules,
      range: stmt.range,
      hitRange: hit
        ? { start: hit.range.start, end: hit.range.end }
        : stmt.keyword.range,
      keywordRange: stmt.keyword.range,
    };
  }
}

/** Attribute values as a FEEL list of unary tests: strings quoted. */
function feelList(values: Text[]): string {
  return values
    .map((v) => (v.quoted ? JSON.stringify(v.value) : v.value))
    .join(',');
}

function logicKeyword(l: TableStmt | LiteralStmt): Range {
  return l.keyword.range;
}

const capital = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function rename(ref: Text, to: string): QuickFix {
  return {
    title: `Change to \`${to}\``,
    edits: [{ range: ref.range, newText: to }],
  };
}
