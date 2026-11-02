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
  /** Colours picked by the compiler (notation §4.7, `option colors`). */
  colors?: ColorScheme;
  /** Whether the output is a collaboration (participants) or a plain process. */
  collaboration: boolean;
  /** Always at least one: a document without `pool` has an implicit one. */
  pools: Pool[];
  messageFlows: MessageFlow[];
  dataStores: DataStore[];
  /** Root-level messages, signals, errors and escalations events share. */
  definitions: EventDefinition[];
  /** In document order, which is also their column order. */
  groups: Group[];
}

export type ColorScheme = 'none' | 'types' | 'lanes' | 'all';

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
  /** The body of an ad-hoc subprocess: activities with no implied order. */
  adHoc?: true;
}

export interface Process extends Container {
  id: string;
  dataObjects: DataObject[];
  /** What is drawn: one reference per (data object, state) used. */
  dataObjectReferences: DataObjectReference[];
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
  | 'eventBasedGateway'
  | 'complexGateway';

export type Marker = 'loop' | 'parallel' | 'sequential';

export interface FlowNode {
  id: string;
  kind: NodeKind;
  name?: string;
  eventType?: EventType;
  laneId?: string;
  groupId?: string;
  markers: Marker[];
  /** Events and send/receive tasks: the shared definition they refer to. */
  definitionRef?: string;
  /** Link throw events: the ID of the catch event with the same name. */
  linkTarget?: string;
  /** Link catch events: the IDs of the throw events with the same name. */
  linkSources?: string[];
  /** Boundary events: the activity they are attached to. */
  attachedTo?: string;
  /** Boundary events, and start events of event subprocesses: false for `[non-interrupting]`. */
  interrupting?: boolean;
  /** Activities: the IDs of their boundary events. */
  boundaries: string[];
  /** Subprocesses: the body. */
  children?: Container;
  collapsed?: boolean;
  /** Ad-hoc subprocesses: the order their activities are performed in. */
  adHoc?: 'Parallel' | 'Sequential';
  /** Event subprocesses: outside the parent's flow, started by an event. */
  triggeredByEvent?: true;
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
  /** Inserted joins: the split (gateway, fork or boundary host) they merge. */
  cause?: Range;
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
  /** The message definition carried, where its ends agree on one. */
  messageRef?: string;
  source: Range;
}

export type DefinitionType = 'message' | 'signal' | 'error' | 'escalation';

/** A definition events of one type and name refer to (notation §4.1). */
export interface EventDefinition {
  id: string;
  type: DefinitionType;
  name: string;
  source: Range;
}

export interface DataObject {
  id: string;
  name: string;
  collection: boolean;
  style?: Style;
  source: Range;
}

/** A use of a data object in one state, which is what is drawn. */
export interface DataObjectReference {
  id: string;
  /** The data object's ID. */
  object: string;
  /** The drawn label: the object's name, with the state under it. */
  name: string;
  state?: string;
  /**
   * The subprocess whose body holds the reference: where it is first used.
   * Absent for the process itself.
   */
  container?: string;
  source: Range;
}

export interface DataStore {
  id: string;
  name: string;
  style?: Style;
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
  style?: Style;
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
