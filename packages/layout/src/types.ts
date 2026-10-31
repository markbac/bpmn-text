import type { Model } from '@bpmn-text/core';
import type { ElkNode } from 'elkjs/lib/elk-api.js';

export interface Point {
  x: number;
  y: number;
}

export interface Bounds extends Point {
  width: number;
  height: number;
}

export interface ShapeLayout extends Bounds {
  /** External label: events, gateways. */
  label?: Bounds;
}

export interface EdgeLayout {
  waypoints: Point[];
  label?: Bounds;
}

/**
 * Positions for every drawn element, by IR ID: pools, lanes and flow nodes
 * in `shapes`, sequence and message flows in `edges`.
 */
export interface LayoutResult {
  shapes: Map<string, ShapeLayout>;
  edges: Map<string, EdgeLayout>;
}

/** The part of the elkjs API the engine uses. */
export interface Elk {
  layout(graph: ElkNode): Promise<ElkNode>;
}

export interface LayoutOptions {
  /**
   * The ELK instance to use. Defaults to the bundled, in-thread elkjs;
   * pass `new ELK({ workerUrl })` to run it in a Web Worker.
   */
  elk?: Elk;
  /** Horizontal space between columns, before edge tracks. Default 50. */
  nodeSpacing?: number;
}

export interface LayoutEngine {
  layout(model: Model, options?: LayoutOptions): Promise<LayoutResult>;
}
