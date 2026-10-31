import type { EventType } from './ast.js';
import type { Range } from './diagnostics.js';

/**
 * The process model (IR): format-independent, close to the BPMN metamodel
 * but simpler (architecture §4). Every element carries its final ID and
 * the source range it came from.
 */
export interface Model {
  title?: string;
  documentation?: string;
  /** How open XOR branches merge (notation §3, `option xor-join`). */
  xorJoin: 'gateway' | 'direct';
  /** Whether the output is a collaboration (participants) or a plain process. */
  collaboration: boolean;
  /** Always at least one: a document without `pool` has an implicit one. */
  pools: Pool[];
  messageFlows: MessageFlow[];
  dataStores: DataStore[];
  /** In document order, which is also their column order. */
  groups: Group[];
}

/** Colours from `[color:]` and `[stroke:]`, normalised to `#RRGGBB`. */
export interface Style {
  fill?: string;
  stroke?: string;
}

export interface Pool {
  id: string;
  name: string;
  collapsed: boolean;
  implicit: boolean;
  lanes: Lane[];
  style?: Style;
  /** Absent for a collapsed pool. */
  process?: Process;
  documentation?: string;
  extra: Record<string, string>;
  source: Range;
}

export interface Lane {
  id: string;
  name: string;
  style?: Style;
  documentation?: string;
  extra: Record<string, string>;
  source: Range;
}

/** A process or the body of a subprocess. */
export interface Container {
  nodes: FlowNode[];
  flows: SequenceFlow[];
  annotations: Annotation[];
}

export interface Process extends Container {
  id: string;
  dataObjects: DataObject[];
  /** The data stores this process uses, one reference each. */
  dataStoreReferences: DataStoreReference[];
}

export type NodeKind =
  | 'startEvent'
  | 'endEvent'
  | 'intermediateCatchEvent'
  | 'intermediateThrowEvent'
  | 'boundaryEvent'
  | 'task'
  | 'userTask'
  | 'serviceTask'
  | 'scriptTask'
  | 'sendTask'
  | 'receiveTask'
  | 'manualTask'
  | 'businessRuleTask'
  | 'callActivity'
  | 'subProcess'
  | 'exclusiveGateway'
  | 'parallelGateway'
  | 'inclusiveGateway'
  | 'eventBasedGateway';

export type Marker = 'loop' | 'parallel' | 'sequential';

export interface FlowNode {
  id: string;
  kind: NodeKind;
  name?: string;
  eventType?: EventType;
  laneId?: string;
  groupId?: string;
  markers: Marker[];
  /** Boundary events: the activity they are attached to. */
  attachedTo?: string;
  /** Boundary events: false for `[non-interrupting]`. */
  interrupting?: boolean;
  /** Activities: the IDs of their boundary events. */
  boundaries: string[];
  /** Subprocesses: the body. */
  children?: Container;
  collapsed?: boolean;
  /** Data input associations: from the data object or store references read. */
  reads: DataAssociation[];
  /** Data output associations: to the references written. */
  writes: DataAssociation[];
  /** Split gateways: how many branches were written. */
  branches?: number;
  /** Gateways: the ID of the default flow (`else:`). */
  default?: string;
  style?: Style;
  documentation?: string;
  /** Set on join gateways the compiler inserted. */
  generated?: 'join';
  /**
   * Set on the last element of a non-interrupting boundary chain that ends
   * open: it was reported as BT241, so it is not also a dead end (BT302).
   */
  endsOpenBoundaryChain?: true;
  /** Attributes the notation does not define, kept for extensions. */
  extra: Record<string, string>;
  /** Where each attribute was written, for diagnostics. */
  attributeRanges: Record<string, Range>;
  source: Range;
}

export interface SequenceFlow {
  id: string;
  sourceRef: string;
  targetRef: string;
  name?: string;
  isDefault?: true;
  source: Range;
}

export interface MessageFlow {
  id: string;
  /** A flow node or a pool. */
  sourceRef: string;
  targetRef: string;
  name?: string;
  source: Range;
}

export interface DataObject {
  id: string;
  /** The ID of its one data object reference, which is what is drawn. */
  reference: string;
  /**
   * The subprocess whose body holds the reference: where the object is
   * first used. Absent for the process itself.
   */
  container?: string;
  name: string;
  collection: boolean;
  source: Range;
}

export interface DataStore {
  id: string;
  name: string;
  source: Range;
}

/** A process's use of a data store, which is what is drawn. */
export interface DataStoreReference {
  id: string;
  /** The data store's ID. */
  store: string;
  /** As for data objects: the subprocess where the store is first used. */
  container?: string;
  source: Range;
}

export interface DataAssociation {
  id: string;
  /** A data object reference or data store reference ID. */
  dataRef: string;
}

export interface Annotation {
  id: string;
  text: string;
  attachedTo: string;
  /** The ID of the association line to `attachedTo`. */
  association: string;
  source: Range;
}

export interface Group {
  id: string;
  name: string;
  fit: boolean;
  style?: Style;
  documentation?: string;
  /** Flow node IDs, across pools. */
  members: string[];
  extra: Record<string, string>;
  source: Range;
}
