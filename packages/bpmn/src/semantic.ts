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
  /** The current process's data references, by subprocess ID. */
  const dataRefs = new Map<string | undefined, ModdleElement[]>();
  const documented = (text: string | undefined) =>
    text
      ? {
          documentation: [
            moddle.create('bpmn:Documentation', {
              text,
              textFormat: 'text/plain',
            }),
          ],
        }
      : {};

  function node(n: FlowNode): ModdleElement {
    const attrs: Record<string, unknown> = {
      id: n.id,
      ...named(n.name),
      ...documented(n.documentation),
    };
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
    const marker = n.markers[0];
    if (marker === 'loop') {
      attrs.loopCharacteristics = moddle.create(
        'bpmn:StandardLoopCharacteristics',
      );
    } else if (marker) {
      attrs.loopCharacteristics = moddle.create(
        'bpmn:MultiInstanceLoopCharacteristics',
        marker === 'sequential' ? { isSequential: true } : {},
      );
    }
    if (n.kind === 'subProcess' && n.children) {
      attrs.flowElements = [
        ...container(n.children),
        ...(dataRefs.get(n.id) ?? []),
      ];
      attrs.artifacts = artifacts(n.children);
    }
    return create(typeOf(n.kind), attrs);
  }

  /**
   * Data associations, linked once every data reference exists. A data
   * input association targets a placeholder property, as bpmn-js does,
   * because the schema requires a target.
   */
  function associateData(n: FlowNode) {
    const element = elements.get(n.id)!;
    if (n.reads.length > 0) {
      const property = moddle.create('bpmn:Property', {
        id: `${n.id}_property`,
        name: '__targetRef_placeholder',
      });
      element.properties = [property];
      element.dataInputAssociations = n.reads.map((a) =>
        create('bpmn:DataInputAssociation', {
          id: a.id,
          sourceRef: [elements.get(a.dataRef)],
          targetRef: property,
        }),
      );
    }
    if (n.writes.length > 0) {
      element.dataOutputAssociations = n.writes.map((a) =>
        create('bpmn:DataOutputAssociation', {
          id: a.id,
          targetRef: elements.get(a.dataRef),
        }),
      );
    }
    for (const child of n.children?.nodes ?? []) associateData(child);
  }

  /** Text annotations and their associations. */
  function artifacts(c: Container): ModdleElement[] {
    return c.annotations.flatMap((a) => {
      const annotation = create('bpmn:TextAnnotation', {
        id: a.id,
        text: a.text,
      });
      return [
        annotation,
        create('bpmn:Association', {
          id: a.association,
          sourceRef: elements.get(a.attachedTo),
          targetRef: annotation,
        }),
      ];
    });
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
    // Data references go in the container where they are first used; the
    // data objects themselves belong to the process.
    dataRefs.clear();
    const addRef = (container: string | undefined, ref: ModdleElement) =>
      dataRefs.set(container, [...(dataRefs.get(container) ?? []), ref]);
    const objects = p.dataObjects.map((o) => {
      const object = create('bpmn:DataObject', {
        id: o.id,
        ...(o.collection ? { isCollection: true } : {}),
      });
      addRef(
        o.container,
        create('bpmn:DataObjectReference', {
          id: o.reference,
          name: o.name,
          dataObjectRef: object,
        }),
      );
      return object;
    });
    for (const r of p.dataStoreReferences) {
      const store = elements.get(r.store)!;
      addRef(
        r.container,
        create('bpmn:DataStoreReference', {
          id: r.id,
          name: store.name,
          dataStoreRef: store,
        }),
      );
    }
    const flowElements = [
      ...container(p),
      ...objects,
      ...(dataRefs.get(undefined) ?? []),
    ];
    for (const n of p.nodes) associateData(n);
    const attrs: Record<string, unknown> = {
      id: p.id,
      isExecutable: false,
      flowElements,
      artifacts: artifacts(p),
    };
    if (!model.collaboration) {
      Object.assign(attrs, named(pool.name), documented(model.documentation));
    }
    if (pool.lanes.length > 0) {
      attrs.laneSets = [
        moddle.create('bpmn:LaneSet', {
          id: `LaneSet_${p.id}`,
          lanes: pool.lanes.map((l) =>
            create('bpmn:Lane', {
              id: l.id,
              ...named(l.name),
              ...documented(l.documentation),
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

  const stores = model.dataStores.map((s) =>
    create('bpmn:DataStore', { id: s.id, name: s.name }),
  );
  const processes = model.pools.filter((p) => p.process).map(process);
  const rootElements = [...stores, ...processes];
  let root = processes[0]!;

  // Groups: one category value each, and the group in the root element.
  const groups = model.groups.map((g) => {
    const value = moddle.create('bpmn:CategoryValue', {
      id: g.id.replace(/^Group_/, 'CategoryValue_'),
      value: g.name,
    });
    return [
      value,
      create('bpmn:Group', {
        id: g.id,
        categoryValueRef: value,
        ...documented(g.documentation),
      }),
    ] as const;
  });
  if (groups.length > 0) {
    rootElements.unshift(
      moddle.create('bpmn:Category', {
        id: 'Category_groups',
        categoryValue: groups.map(([value]) => value),
      }),
    );
  }
  const groupElements = groups.map(([, group]) => group);

  if (model.collaboration) {
    const participants = model.pools.map((p) =>
      create('bpmn:Participant', {
        id: p.id,
        ...named(p.name),
        ...documented(p.documentation),
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
      ...documented(model.documentation),
      participants,
      messageFlows,
      artifacts: groupElements,
    });
    rootElements.splice(groups.length > 0 ? 1 : 0, 0, root);
  } else {
    push(root, 'artifacts', ...groupElements);
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

function push(element: ModdleElement, property: string, ...values: unknown[]) {
  const list = (element[property] as unknown[] | undefined) ?? [];
  list.push(...values);
  element[property] = list;
}
