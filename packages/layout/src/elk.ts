import ElkWorkerModule from 'elkjs/lib/elk-worker.min.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { Elk } from './types.js';

/** The part of elkjs's in-thread worker that runs a layout. */
interface ElkWorker {
  onmessage: (message: {
    data: { id: number; data?: ElkNode; error?: unknown };
  }) => void;
  dispatcher: {
    saveDispatch(message: {
      data:
        | { id: number; cmd: 'layout'; graph: ElkNode }
        | { id: number; cmd: 'register'; algorithms: string[] };
    }): void;
  };
}

// elkjs is CommonJS: Node's ESM loader exposes its exports as `default`,
// while bundlers may return them directly.
const exported = ElkWorkerModule as unknown as {
  Worker?: new () => ElkWorker;
  default?: { Worker: new () => ElkWorker };
};
const ElkWorkerConstructor = (exported.Worker ?? exported.default!.Worker)!;

/**
 * elkjs run directly in this thread. elkjs's own in-thread API hands each
 * layout to its fake worker and back with two `setTimeout(…, 0)` calls,
 * which on Windows wait for the 15.6 ms timer tick each: around 30 ms per
 * layout, and one layout per subprocess body, while the layout itself
 * takes about a millisecond. This calls the worker's dispatcher instead,
 * which lays the graph out synchronously.
 */
export class InThreadElk implements Elk {
  private worker: ElkWorker | undefined;
  private nextId = 0;

  layout(graph: ElkNode): Promise<ElkNode> {
    let result: { data?: ElkNode; error?: unknown } | undefined;
    try {
      result = this.send({ id: this.nextId++, cmd: 'layout', graph });
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    if (!result) {
      return Promise.reject(new Error('elkjs did not answer the layout.'));
    }
    if (result.error !== undefined || !result.data) {
      const error = result.error;
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return Promise.resolve(result.data);
  }

  /** Runs one command; the worker answers before this returns. */
  private send(
    data: Parameters<ElkWorker['dispatcher']['saveDispatch']>[0]['data'],
  ) {
    const worker = this.start();
    let answer: { data?: ElkNode; error?: unknown } | undefined;
    worker.onmessage = (message) => {
      if (message.data.id === data.id) answer = message.data;
    };
    worker.dispatcher.saveDispatch({ data });
    return answer;
  }

  /**
   * The worker, created on first use since it loads parts of elkjs
   * lazily, with the one algorithm the engine uses registered.
   */
  private start(): ElkWorker {
    if (this.worker) return this.worker;
    const worker = new ElkWorkerConstructor();
    this.worker = worker;
    const registered = this.send({
      id: this.nextId++,
      cmd: 'register',
      algorithms: ['layered'],
    });
    if (registered?.error !== undefined) {
      this.worker = undefined;
      throw registered.error;
    }
    return worker;
  }
}

/** The ELK instance layouts use unless they are given one. */
export const defaultElk: Elk = new InThreadElk();
