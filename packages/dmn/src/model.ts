import type { Range, Style } from '@bpmn-text/core';
import type { DmnKind } from './ast.js';
import type { Aggregation, HitPolicy } from './parser.js';

/**
 * The DMN intermediate representation: the DRD and each element's logic,
 * with deterministic IDs and source ranges.
 */
export interface DmnModel {
  /** The definitions' ID, such as `Definitions_loan_approval`. */
  id: string;
  name: string;
  /** In source order. */
  elements: DmnElement[];
  requirements: Requirement[];
}

export type DmnElement = Decision | InputData | Knowledge | KnowledgeSource;

interface ElementBase {
  id: string;
  name: string;
  /** The whole statement. */
  range: Range;
  /** The name as written. */
  nameRange: Range;
  doc?: string;
  style?: Style;
}

export interface Decision extends ElementBase {
  kind: 'decision';
  /** The type of the decision's result. */
  typeRef?: string;
  logic?: DecisionTable | LiteralExpression;
}

export interface InputData extends ElementBase {
  kind: 'input';
  typeRef?: string;
  /** Allowed values, as FEEL unary tests, such as `"a","b"`. */
  values?: string;
}

export interface Knowledge extends ElementBase {
  kind: 'knowledge';
  typeRef?: string;
  params: { name: string; typeRef?: string; range: Range }[];
  logic?: LiteralExpression;
}

export interface KnowledgeSource extends ElementBase {
  kind: 'source';
}

export type RequirementKind = 'information' | 'knowledge' | 'authority';

/** `from` is required by `to`, as DMN draws it: an arrow from `from` to `to`. */
export interface Requirement {
  id: string;
  kind: RequirementKind;
  from: string;
  to: string;
  /** The name in `[requires: …]`. */
  range: Range;
}

export interface DecisionTable {
  type: 'table';
  id: string;
  hitPolicy: HitPolicy;
  aggregation?: Aggregation;
  inputs: InputClause[];
  outputs: OutputClause[];
  /** The annotation column's title, if the table has one. */
  annotation?: string;
  rules: DmnRule[];
  /** The `table` line. */
  range: Range;
  /** The hit policy as written, or the `table` keyword. */
  hitRange: Range;
  /** The `table` keyword. */
  keywordRange: Range;
}

export interface InputClause {
  id: string;
  /** The FEEL input expression, such as `Credit score`. */
  expression: string;
  expressionId: string;
  typeRef?: string;
  values?: string;
  /** The header cell. */
  range: Range;
  /** The expression in the header cell. */
  expressionRange: Range;
}

export interface OutputClause {
  id: string;
  name: string;
  typeRef?: string;
  values?: string;
  range: Range;
}

/** A cell: FEEL text and where it was written. */
export interface Entry {
  id: string;
  text: string;
  range: Range;
}

export interface DmnRule {
  id: string;
  /** 1-based, in table order. */
  index: number;
  inputEntries: Entry[];
  outputEntries: Entry[];
  description?: string;
  range: Range;
}

export interface LiteralExpression {
  type: 'literal';
  id: string;
  text: string;
  /** Each line of the expression, so offsets map back to the source. */
  lines: { text: string; range: Range }[];
  range: Range;
}

export type { DmnKind };
