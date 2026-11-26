import { DmnModdle, type ModdleElement } from 'dmn-moddle';
import type { DrdLayout } from './layout.js';
import type {
  DecisionTable,
  DmnElement,
  DmnModel,
  LiteralExpression,
  Requirement,
} from './model.js';

/**
 * Serialises `model` as DMN 1.3 XML. With a `layout`, the output includes
 * DMNDI (shapes and edges); without, it is the semantic part only.
 */
export async function generateDmn(
  model: DmnModel,
  layout?: DrdLayout,
): Promise<string> {
  const moddle = new DmnModdle();
  const create = (type: string, attrs: Record<string, unknown> = {}) =>
    moddle.create(type, attrs);
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const ref = (id: string) =>
    create('dmn:DMNElementReference', { href: `#${id}` });
  const doc = (e: { doc?: string }) => (e.doc ? { description: e.doc } : {});

  const literal = (l: LiteralExpression, typeRef?: string) =>
    create('dmn:LiteralExpression', {
      id: l.id,
      ...(typeRef ? { typeRef } : {}),
      text: l.text,
    });

  const requirementsOf = (e: DmnElement) => {
    const info: ModdleElement[] = [];
    const knowledge: ModdleElement[] = [];
    const authority: ModdleElement[] = [];
    for (const r of model.requirements.filter((x) => x.to === e.id)) {
      const from = byId.get(r.from);
      if (!from) continue;
      if (r.kind === 'information') {
        info.push(
          create('dmn:InformationRequirement', {
            id: r.id,
            [from.kind === 'input' ? 'requiredInput' : 'requiredDecision']: ref(
              r.from,
            ),
          }),
        );
      } else if (r.kind === 'knowledge') {
        knowledge.push(
          create('dmn:KnowledgeRequirement', {
            id: r.id,
            requiredKnowledge: ref(r.from),
          }),
        );
      } else {
        const property =
          from.kind === 'input'
            ? 'requiredInput'
            : from.kind === 'decision'
              ? 'requiredDecision'
              : 'requiredAuthority';
        authority.push(
          create('dmn:AuthorityRequirement', {
            id: r.id,
            [property]: ref(r.from),
          }),
        );
      }
    }
    return {
      ...(info.length ? { informationRequirement: info } : {}),
      ...(knowledge.length ? { knowledgeRequirement: knowledge } : {}),
      ...(authority.length ? { authorityRequirement: authority } : {}),
    };
  };

  const table = (t: DecisionTable) =>
    create('dmn:DecisionTable', {
      id: t.id,
      ...(t.hitPolicy !== 'UNIQUE' ? { hitPolicy: t.hitPolicy } : {}),
      ...(t.aggregation ? { aggregation: t.aggregation } : {}),
      input: t.inputs.map((i) =>
        create('dmn:InputClause', {
          id: i.id,
          inputExpression: create('dmn:LiteralExpression', {
            id: i.expressionId,
            ...(i.typeRef ? { typeRef: i.typeRef } : {}),
            text: i.expression,
          }),
          ...(i.values
            ? {
                inputValues: create('dmn:UnaryTests', { text: i.values }),
              }
            : {}),
        }),
      ),
      output: t.outputs.map((o) =>
        create('dmn:OutputClause', {
          id: o.id,
          name: o.name,
          ...(o.typeRef ? { typeRef: o.typeRef } : {}),
          ...(o.values
            ? {
                outputValues: create('dmn:UnaryTests', { text: o.values }),
              }
            : {}),
        }),
      ),
      rule: t.rules.map((r) =>
        create('dmn:DecisionRule', {
          id: r.id,
          ...(r.description ? { description: r.description } : {}),
          inputEntry: r.inputEntries.map((e) =>
            create('dmn:UnaryTests', { id: e.id, text: e.text }),
          ),
          outputEntry: r.outputEntries.map((e) =>
            create('dmn:LiteralExpression', { id: e.id, text: e.text }),
          ),
        }),
      ),
    });

  const variable = (e: DmnElement & { typeRef?: string }) =>
    create('dmn:InformationItem', {
      id: `InformationItem_${e.id.slice(e.id.indexOf('_') + 1)}`,
      name: e.name,
      ...(e.typeRef ? { typeRef: e.typeRef } : {}),
    });

  const drg = model.elements.map((e) => {
    const base = { id: e.id, name: e.name, ...doc(e) };
    switch (e.kind) {
      case 'decision':
        return create('dmn:Decision', {
          ...base,
          ...(e.typeRef || e.logic?.type === 'literal'
            ? { variable: variable(e) }
            : {}),
          ...requirementsOf(e),
          ...(e.logic
            ? {
                decisionLogic:
                  e.logic.type === 'table' ? table(e.logic) : literal(e.logic),
              }
            : {}),
        });
      case 'input':
        return create('dmn:InputData', {
          ...base,
          variable: variable(e),
        });
      case 'knowledge':
        return create('dmn:BusinessKnowledgeModel', {
          ...base,
          variable: variable(e),
          ...(e.logic || e.params.length
            ? {
                encapsulatedLogic: create('dmn:FunctionDefinition', {
                  id: `FunctionDefinition_${e.id.slice(e.id.indexOf('_') + 1)}`,
                  formalParameter: e.params.map((p, k) =>
                    create('dmn:InformationItem', {
                      id: `InformationItem_${e.id.slice(e.id.indexOf('_') + 1)}_${k + 1}`,
                      name: p.name,
                      ...(p.typeRef ? { typeRef: p.typeRef } : {}),
                    }),
                  ),
                  ...(e.logic ? { body: literal(e.logic) } : {}),
                }),
              }
            : {}),
          ...requirementsOf(e),
        });
      case 'source':
        return create('dmn:KnowledgeSource', {
          ...base,
          ...requirementsOf(e),
        });
    }
  });

  const definitions = create('dmn:Definitions', {
    id: model.id,
    name: model.name,
    namespace: 'http://bpmn.io/schema/dmn',
    exporter: 'bpmn-text',
    drgElement: drg,
  });
  if (model.elements.some((e) => e.style))
    (definitions.$attrs as Record<string, string>)['xmlns:color'] =
      'http://www.omg.org/spec/BPMN/non-normative/color/1.0';

  if (layout) {
    const shapes = model.elements.flatMap((e) => {
      const b = layout.shapes.get(e.id);
      if (!b) return [];
      const shape = create('dmndi:DMNShape', {
        id: `DMNShape_${e.id}`,
        dmnElementRef: drg[model.elements.indexOf(e)],
        bounds: create('dc:Bounds', { ...b }),
      });
      // Colours as in the BPMN output (ADR-011): the OMG non-normative
      // colour attributes. A DMNDI style would be standard, but dmn-moddle,
      // and so Camunda Modeler, reads its colours wrongly and warns.
      if (e.style) {
        const attrs = shape.$attrs as Record<string, string>;
        if (e.style.fill) attrs['color:background-color'] = e.style.fill;
        if (e.style.stroke) attrs['color:border-color'] = e.style.stroke;
      }
      return [shape];
    });
    const elementOf = new Map<string, ModdleElement>();
    for (const d of drg) {
      for (const key of [
        'informationRequirement',
        'knowledgeRequirement',
        'authorityRequirement',
      ]) {
        for (const r of (d[key] as ModdleElement[] | undefined) ?? [])
          elementOf.set(r.id as string, r);
      }
    }
    const edges = model.requirements.flatMap((r: Requirement) => {
      const points = layout.edges.get(r.id);
      const element = elementOf.get(r.id);
      if (!points || !element) return [];
      return [
        create('dmndi:DMNEdge', {
          id: `DMNEdge_${r.id}`,
          dmnElementRef: element,
          waypoint: points.map((p) => create('dc:Point', { ...p })),
        }),
      ];
    });
    definitions.dmnDI = create('dmndi:DMNDI', {
      diagrams: [
        create('dmndi:DMNDiagram', {
          id: 'DMNDiagram_1',
          diagramElements: [...edges, ...shapes],
        }),
      ],
    });
  }

  const { xml } = await moddle.toXML(definitions, { format: true });
  return `${xml}\n`;
}
