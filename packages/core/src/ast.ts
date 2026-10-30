import type { Range } from './diagnostics.js';

/** The AST mirrors the text closely; every node has a source range. */

export type EventType =
  | 'message'
  | 'timer'
  | 'signal'
  | 'conditional'
  | 'error'
  | 'escalation'
  | 'compensation'
  | 'terminate'
  | 'link';

/** `wait` is read as `catch` with event type `timer`. */
export type ElementKind =
  | 'start'
  | 'end'
  | 'catch'
  | 'throw'
  | 'task'
  | 'user'
  | 'service'
  | 'script'
  | 'send'
  | 'receive'
  | 'manual'
  | 'rule'
  | 'call'
  | 'sub'
  | 'xor'
  | 'and'
  | 'or'
  | 'event'
  | 'on';

/** A name, label or value as written: bare or quoted. */
export interface Text {
  value: string;
  quoted: boolean;
  range: Range;
}

/** `key` (a flag) or `key: value, value`. */
export interface Attr {
  key: Text;
  values: Text[];
  range: Range;
}

export interface ElementDecl {
  type: 'element';
  kind: ElementKind;
  /** The keyword as written, such as `wait`. */
  keyword: Text;
  eventType?: EventType;
  name?: Text;
  id?: Text;
  attrs: Attr[];
  range: Range;
}

/** A reference to an element or pool, by `@id` or by name. */
export interface Ref {
  type: 'ref';
  id?: Text;
  name?: Text;
  range: Range;
}

/**
 * One arrow and what it points at. A sequence flow can have several
 * targets (`-> A, B`); only the first can be an inline declaration.
 */
export interface FlowStep {
  op: 'sequence' | 'message';
  label?: Text;
  targets: (ElementDecl | Ref)[];
  range: Range;
}

export interface ElementStmt {
  type: 'element-stmt';
  element: ElementDecl;
  tail: FlowStep[];
  boundaries: BoundaryStmt[];
  range: Range;
}

export interface BoundaryStmt {
  type: 'boundary';
  /** An element of kind `on`. */
  element: ElementDecl;
  tail: FlowStep[];
  body: Statement[];
  range: Range;
}

/** A gateway; without branches it is a plain node (notation §7.3). */
export interface GatewayStmt {
  type: 'gateway';
  element: ElementDecl;
  branches?: Branch[];
  range: Range;
}

export interface ForkStmt {
  type: 'fork';
  branches: Branch[];
  range: Range;
}

export interface Branch {
  type: 'branch';
  form: 'labelled' | 'bullet' | 'else';
  label?: Text;
  /** A chain on the branch line itself. */
  inline?: { target: ElementDecl | Ref; tail: FlowStep[] };
  body: Statement[];
  range: Range;
}

export interface SubStmt {
  type: 'sub';
  element: ElementDecl;
  /** Absent for a collapsed placeholder with no body (notation §4.8). */
  body?: Statement[];
  boundaries: BoundaryStmt[];
  range: Range;
}

export interface GroupStmt {
  type: 'group';
  name: Text;
  attrs: Attr[];
  body: Statement[];
  range: Range;
}

export interface PoolStmt {
  type: 'pool';
  name: Text;
  attrs: Attr[];
  /** Absent for a collapsed pool. */
  body?: Statement[];
  range: Range;
}

export interface LaneStmt {
  type: 'lane';
  name: Text;
  attrs: Attr[];
  range: Range;
}

export interface LanesStmt {
  type: 'lanes';
  lanes: { name: Text; attrs: Attr[]; range: Range }[];
  range: Range;
}

/** A line that starts with an arrow: flows from the previous element. */
export interface GotoStmt {
  type: 'goto';
  tail: FlowStep[];
  range: Range;
}

/** A standalone message flow: `A ~> B`. */
export interface MessageStmt {
  type: 'message';
  source: Ref;
  step: FlowStep;
  range: Range;
}

export interface NoteStmt {
  type: 'note';
  text: Text;
  range: Range;
}

/** Documentation; block lines are joined with line breaks. */
export interface DocStmt {
  type: 'doc';
  text: string;
  range: Range;
}

export interface DataStmt {
  type: 'data';
  kind: 'data' | 'store';
  name: Text;
  attrs: Attr[];
  range: Range;
}

export type Statement =
  | ElementStmt
  | GatewayStmt
  | ForkStmt
  | SubStmt
  | GroupStmt
  | PoolStmt
  | LaneStmt
  | LanesStmt
  | GotoStmt
  | MessageStmt
  | NoteStmt
  | DocStmt
  | DataStmt;

export interface TitleDirective {
  type: 'title';
  value: Text;
  range: Range;
}

export interface OptionDirective {
  type: 'option';
  key: Text;
  value: Text;
  range: Range;
}

export type Directive = TitleDirective | OptionDirective;

export interface Document {
  type: 'document';
  directives: Directive[];
  body: Statement[];
  range: Range;
}
