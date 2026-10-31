import type {
  Container,
  EventType,
  FlowNode,
  Model,
  Pool,
} from '@bpmn-text/core';
import type { BpmnModdle, ModdleElement } from 'bpmn-moddle';

export interface Semantic {
  definitions: ModdleElement;
  /** The element the main diagram plane shows: the collaboration or process. */
  root: ModdleElement;
  /** Every element with an IR ID, by that ID. */
  elements: Map<string, ModdleElement>;
}

const definitionType: Record<EventType, string> = {
  message: 'bpmn:MessageEventDefinition',
  timer: 'bpmn:TimerEventDefinition',
  signal: 'bpmn:SignalEventDefinition',
  conditional: 'bpmn:ConditionalEventDefinition',
  error: 'bpmn:ErrorEventDefinition',
  escalation: 'bpmn:EscalationEventDefinition',
  compensation: 'bpmn:CompensateEventDefinition',
  terminate: 'bpmn:TerminateEventDefinition',
  link: 'bpmn:LinkEventDefinition',
};

/** `userTask` → `bpmn:UserTask`. */
const typeOf = (kind: string) =>
  `bpmn:${kind[0]!.toUpperCase()}${kind.slice(1)}`;

/**
 * Builds the semantic part of the BPMN document (architecture §7): a
 * collaboration with participants and message flows when the model has
 * pools, and one process per expanded pool with its lanes, flow nodes and
 * sequence flows.
 */
export function semantic(model: Model, moddle: BpmnModdle): Semantic {
  const elements = new Map<string, ModdleElement>();
  const create = (type: string, attrs: Record<string, unknown>) => {
    const element = moddle.create(type, attrs);
    if (typeof attrs.id === 'string') elements.set(attrs.id, element);
    return element;
  };
  const named = (name: string | undefined) => (name ? { name } : {});

  function node(n: FlowNode): ModdleElement {
    const attrs: Record<string, unknown> = { id: n.id, ...named(n.name) };
    if (n.eventType) {
      const definition: Record<string, unknown> = { id: `${n.id}_definition` };
      // The schema requires a condition and a link name.
      if (n.eventType === 'conditional') {
        definition.condition = moddle.create('bpmn:FormalExpression');
      }
      if (n.eventType === 'link') definition.name = n.name ?? '';
      attrs.eventDefinitions = [
        moddle.create(definitionType[n.eventType], definition),
      ];
    }
    if (n.interrupting === false) attrs.cancelActivity = false;
    if (n.kind === 'subProcess' && n.children) {
      attrs.flowElements = container(n.children);
    }
    return create(typeOf(n.kind), attrs);
  }

  /** Flow nodes, then sequence flows, with their references linked. */
  function container(c: Container): ModdleElement[] {
    const nodes = c.nodes.map(node);
    const flows = c.flows.map((f) => {
      const source = elements.get(f.sourceRef)!;
      const target = elements.get(f.targetRef)!;
      const flow = create('bpmn:SequenceFlow', {
        id: f.id,
        ...named(f.name),
        sourceRef: source,
        targetRef: target,
      });
      push(source, 'outgoing', flow);
      push(target, 'incoming', flow);
      return flow;
    });
    for (const n of c.nodes) {
      const element = elements.get(n.id)!;
      if (n.attachedTo) element.attachedToRef = elements.get(n.attachedTo);
      if (n.default) element.default = elements.get(n.default);
    }
    return [...nodes, ...flows];
  }

  function process(pool: Pool): ModdleElement {
    const p = pool.process!;
    const flowElements = container(p);
    const attrs: Record<string, unknown> = {
      id: p.id,
      isExecutable: false,
      flowElements,
    };
    if (!model.collaboration) Object.assign(attrs, named(pool.name));
    if (pool.lanes.length > 0) {
      attrs.laneSets = [
        moddle.create('bpmn:LaneSet', {
          id: `LaneSet_${p.id}`,
          lanes: pool.lanes.map((l) =>
            create('bpmn:Lane', {
              id: l.id,
              ...named(l.name),
              flowNodeRef: p.nodes
                .filter((n) => n.laneId === l.id)
                .map((n) => elements.get(n.id)),
            }),
          ),
        }),
      ];
    }
    return create('bpmn:Process', attrs);
  }

  const processes = model.pools.filter((p) => p.process).map(process);
  const rootElements = [...processes];
  let root = processes[0]!;
  if (model.collaboration) {
    const participants = model.pools.map((p) =>
      create('bpmn:Participant', {
        id: p.id,
        ...named(p.name),
        ...(p.process ? { processRef: elements.get(p.process.id) } : {}),
      }),
    );
    const messageFlows = model.messageFlows.map((f) =>
      create('bpmn:MessageFlow', {
        id: f.id,
        ...named(f.name),
        sourceRef: elements.get(f.sourceRef),
        targetRef: elements.get(f.targetRef),
      }),
    );
    root = moddle.create('bpmn:Collaboration', {
      id: 'Collaboration_1',
      participants,
      messageFlows,
    });
    rootElements.unshift(root);
  }

  const definitions = moddle.create('bpmn:Definitions', {
    id: 'Definitions_1',
    ...named(model.title),
    targetNamespace: 'http://bpmn.io/schema/bpmn',
    exporter: 'bpmn-text',
    rootElements,
  });
  return { definitions, root, elements };
}

function push(element: ModdleElement, property: string, value: unknown) {
  const list = (element[property] as unknown[] | undefined) ?? [];
  list.push(value);
  element[property] = list;
}
