import type { Range, Text } from '@bpmn-text/core';

/** The DMN AST mirrors the text closely; every node has a source range. */

export type DmnKind = 'input' | 'decision' | 'knowledge' | 'source';

/** `key: value, value`. */
export interface DmnAttr {
  key: Text;
  values: Text[];
  range: Range;
}

export interface DmnDocument {
  type: 'document';
  title?: Text;
  elements: ElementStmt[];
  range: Range;
}

export interface ElementStmt {
  type: 'element';
  kind: DmnKind;
  keyword: Text;
  name: Text;
  id?: Text;
  attrs: DmnAttr[];
  docs: DocStmt[];
  /** Tables and literals, as written; the builder reports more than one. */
  logic: (TableStmt | LiteralStmt)[];
  range: Range;
}

export interface DocStmt {
  type: 'doc';
  text: string;
  range: Range;
}

/** One line of a literal expression, as written. */
export interface RawLine {
  text: string;
  range: Range;
}

export interface LiteralStmt {
  type: 'literal';
  keyword: Text;
  /** The FEEL text, lines joined with `\n`. */
  text: string;
  lines: RawLine[];
  range: Range;
}

/** A cell as written, trimmed; `\|` is unescaped in `text`. */
export interface Cell {
  text: string;
  /** The cell as written, trimmed, with escapes kept. */
  raw: string;
  range: Range;
}

export interface Row {
  cells: Cell[];
  /** Whether the row ends with `|`. */
  closed: boolean;
  range: Range;
}

export type ColumnRole = 'input' | 'output' | 'annotation';

/** A header cell, read. */
export interface Column {
  role: ColumnRole;
  /** The input expression, output name or annotation title. */
  label: Text;
  /** Whether the cell was written with `->` (first output) or `//`. */
  marker?: '->' | '//';
  typeRef?: Text;
  /** Allowed values, as FEEL, after `in`. */
  values?: Text;
  range: Range;
}

export interface TableStmt {
  type: 'table';
  keyword: Text;
  attrs: DmnAttr[];
  /** Absent when the table has no rows at all. */
  header?: Row;
  columns: Column[];
  rows: Row[];
  range: Range;
}
