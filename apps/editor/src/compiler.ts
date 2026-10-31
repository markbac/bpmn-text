import type { Compiled } from './compile.js';

/** How long typing must pause before a compile starts. */
export const DEBOUNCE_MS = 150;

interface Port {
  postMessage(message: { id: number; source: string }): void;
  onmessage: ((event: MessageEvent<Compiled & { id: number }>) => void) | null;
}

/**
 * Runs compiles in a worker, one at a time. Text that arrives while a
 * compile runs waits, and only the newest waiting text is compiled, so
 * stale versions are skipped rather than queued.
 */
export class Compiler {
  /** The source being compiled now. */
  private running: string | undefined;
  private waiting: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 0;

  constructor(
    private readonly port: Port,
    private readonly onResult: (result: Compiled, source: string) => void,
    private readonly delay = DEBOUNCE_MS,
  ) {
    port.onmessage = (event) => {
      const source = this.running!;
      this.running = undefined;
      this.onResult(event.data, source);
      if (this.waiting !== undefined) {
        const next = this.waiting;
        this.waiting = undefined;
        this.run(next);
      }
    };
  }

  /** Compiles `source` once typing pauses, or now with `immediate`. */
  update(source: string, immediate = false): void {
    clearTimeout(this.timer);
    if (immediate) this.run(source);
    else this.timer = setTimeout(() => this.run(source), this.delay);
  }

  private run(source: string) {
    if (this.running !== undefined) {
      this.waiting = source;
      return;
    }
    this.running = source;
    this.port.postMessage({ id: this.nextId++, source });
  }
}
