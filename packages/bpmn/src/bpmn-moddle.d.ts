// bpmn-moddle publishes types for its model only, not for its entry point.
declare module 'bpmn-moddle' {
  export interface ModdleElement {
    $type: string;
    [property: string]: unknown;
  }
  export class BpmnModdle {
    create(type: string, attrs?: Record<string, unknown>): ModdleElement;
    toXML(
      element: ModdleElement,
      options?: { format?: boolean },
    ): Promise<{ xml: string }>;
  }
}
