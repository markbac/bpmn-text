// dmn-moddle publishes no types.
declare module 'dmn-moddle' {
  export class DmnModdle {
    fromXML(xml: string): Promise<{ warnings: Error[] }>;
  }
}
