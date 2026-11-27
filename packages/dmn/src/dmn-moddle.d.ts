// dmn-moddle publishes no types.
declare module 'dmn-moddle' {
  export interface ModdleElement {
    $type: string;
    $attrs: Record<string, unknown>;
    [property: string]: unknown;
  }
  export class DmnModdle {
    create(type: string, attrs?: Record<string, unknown>): ModdleElement;
    toXML(
      element: ModdleElement,
      options?: { format?: boolean },
    ): Promise<{ xml: string }>;
    fromXML(
      xml: string,
      type?: string,
    ): Promise<{ rootElement: ModdleElement; warnings: Error[] }>;
  }
}
