// bpmn-moddle publishes types for its model only, not for its entry point.
declare module 'bpmn-moddle' {
  export class BpmnModdle {
    fromXML(xml: string): Promise<{ warnings: Error[] }>;
  }
}
