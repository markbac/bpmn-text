/**
 * The DMN preview (#79): dmn-js, loaded on first use so that BPMN users
 * never download it. It shows the DRD, or the table or literal of the
 * decision the cursor is in, and keeps the selection in step both ways.
 */

interface DmnView {
  type: 'drd' | 'decisionTable' | 'literalExpression' | string;
  element: { id: string };
}
interface EventBus {
  on(
    event: string,
    callback: (e: {
      element: { id: string; businessObject?: { id: string } };
      originalEvent?: MouseEvent;
    }) => void,
  ): void;
}
interface DrdViewer {
  get(name: 'canvas'): {
    zoom(level: 'fit-viewport'): void;
    viewbox(box?: object): {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    addMarker(id: string, marker: string): void;
    removeMarker(id: string, marker: string): void;
  };
  get(name: 'elementRegistry'): {
    get(id: string): unknown;
    getGraphics(id: string): SVGElement | undefined;
  };
  get(name: 'eventBus'): EventBus;
  saveSVG(): Promise<{ svg: string }>;
}
interface DmnViewer {
  importXML(xml: string): Promise<unknown>;
  getViews(): DmnView[];
  getActiveView(): DmnView | undefined;
  open(view: DmnView): Promise<unknown>;
  getActiveViewer(): DrdViewer | undefined;
  getDefinitions(): {
    dmnDI?: {
      diagrams?: {
        diagramElements?: {
          dmnElementRef?: { id: string };
          $attrs?: Record<string, string | undefined>;
        }[];
      }[];
    };
  };
}

export interface DmnPreviewEvents {
  /** An element was clicked: select its source. */
  onSelect(id: string): void;
  onHover(id: string, event: MouseEvent | undefined): void;
  onOut(): void;
}

const SELECTED = 'source-selected';

export class DmnPreview {
  private viewer: Promise<DmnViewer> | undefined;
  private wired = new WeakSet<object>();
  private marked: string | undefined;
  /** The decision whose table or literal is open, if any. */
  private decision: string | undefined;

  constructor(
    private readonly container: HTMLElement,
    private readonly events: DmnPreviewEvents,
  ) {
    // Clicks in a table or literal view: the cell, rule or clause.
    container.addEventListener('click', (event) => {
      const target = (event.target as Element).closest('[data-element-id]');
      const id = target?.getAttribute('data-element-id');
      if (id) this.events.onSelect(id);
    });
  }

  private load(): Promise<DmnViewer> {
    this.viewer ??= (async () => {
      const [{ default: Viewer }] = await Promise.all([
        import('dmn-js/lib/Viewer.js'),
        import('dmn-js/dist/assets/diagram-js.css'),
        import('dmn-js/dist/assets/dmn-js-shared.css'),
        import('dmn-js/dist/assets/dmn-js-drd.css'),
        import('dmn-js/dist/assets/dmn-js-decision-table.css'),
        import('dmn-js/dist/assets/dmn-js-literal-expression.css'),
        import('dmn-js/dist/assets/dmn-font/css/dmn-embedded.css'),
      ]);
      return new (
        Viewer as unknown as new (options: {
          container: HTMLElement;
        }) => DmnViewer
      )({ container: this.container });
    })();
    return this.viewer;
  }

  /** Shows new XML, keeping the view and, unless `fit`, the zoom. */
  async show(xml: string, fit: boolean): Promise<void> {
    const viewer = await this.load();
    const drd = this.drd(viewer);
    const box = !fit && drd ? drd.get('canvas').viewbox() : undefined;
    await viewer.importXML(xml);
    this.marked = undefined;
    const reopen = this.decision;
    this.decision = undefined;
    const now = this.drd(viewer);
    if (now) {
      this.wire(now);
      this.colour(viewer, now);
      if (box) now.get('canvas').viewbox({ ...box });
      else now.get('canvas').zoom('fit-viewport');
    }
    if (reopen) await this.focus(reopen, undefined);
  }

  /** The DRD viewer, when the DRD is the open view. */
  private drd(viewer: DmnViewer): DrdViewer | undefined {
    return viewer.getActiveView()?.type === 'drd'
      ? viewer.getActiveViewer()
      : undefined;
  }

  /**
   * Draws the colours written on shapes (`color:background-color` and
   * `color:border-color`), which dmn-js does not draw itself.
   */
  private colour(viewer: DmnViewer, drd: DrdViewer) {
    const registry = drd.get('elementRegistry');
    const elements =
      viewer.getDefinitions().dmnDI?.diagrams?.[0]?.diagramElements ?? [];
    for (const e of elements) {
      const id = e.dmnElementRef?.id;
      const fill = e.$attrs?.['color:background-color'];
      const stroke = e.$attrs?.['color:border-color'];
      if (!id || (!fill && !stroke)) continue;
      const shape = registry
        .getGraphics(id)
        ?.querySelector<SVGElement>('.djs-visual > :first-child');
      if (!shape) continue;
      if (fill) shape.style.fill = fill;
      if (stroke) shape.style.stroke = stroke;
    }
  }

  private wire(drd: DrdViewer) {
    if (this.wired.has(drd)) return;
    this.wired.add(drd);
    const bus = drd.get('eventBus');
    const id = (e: {
      element: { id: string; businessObject?: { id: string } };
    }) => e.element.businessObject?.id ?? e.element.id;
    bus.on('element.click', (e) => this.events.onSelect(id(e)));
    bus.on('element.hover', (e) => this.events.onHover(id(e), e.originalEvent));
    bus.on('element.out', () => this.events.onOut());
  }

  /**
   * Opens the table or literal of `decision`, or the DRD without one, and
   * marks `element` in it.
   */
  async focus(
    decision: string | undefined,
    element: string | undefined,
  ): Promise<void> {
    const viewer = await this.viewer;
    if (!viewer) return;
    if (decision !== this.decision) {
      const view = viewer
        .getViews()
        .find((v) =>
          decision
            ? v.element.id === decision && v.type !== 'drd'
            : v.type === 'drd',
        );
      if (view && view !== viewer.getActiveView()) {
        await viewer.open(view);
        this.marked = undefined;
        const drd = this.drd(viewer);
        if (drd) {
          this.wire(drd);
          this.colour(viewer, drd);
          drd.get('canvas').zoom('fit-viewport');
        }
      }
      this.decision = view ? decision : undefined;
    }
    this.mark(viewer, element);
  }

  private mark(viewer: DmnViewer, id: string | undefined) {
    if (this.marked === id) return;
    const drd = this.drd(viewer);
    if (this.marked) {
      if (drd?.get('elementRegistry').get(this.marked))
        drd.get('canvas').removeMarker(this.marked, SELECTED);
      for (const e of this.container.querySelectorAll(`.${SELECTED}`))
        e.classList.remove(SELECTED);
    }
    this.marked = id;
    if (!id) return;
    if (drd?.get('elementRegistry').get(id)) {
      drd.get('canvas').addMarker(id, SELECTED);
      return;
    }
    for (const e of this.container.querySelectorAll(
      `[data-element-id="${CSS.escape(id)}"], [data-row-id="${CSS.escape(id)}"]`,
    ))
      e.classList.add(SELECTED);
  }

  /** Whether element `id` is drawn in the open view. */
  has(id: string): boolean {
    if (!this.viewer) return false;
    return (
      this.container.querySelector(
        `[data-element-id="${CSS.escape(id)}"], [data-row-id="${CSS.escape(id)}"]`,
      ) !== null
    );
  }

  /** The DRD as SVG, for downloads, whichever view is open. */
  async drdSvg(): Promise<string> {
    const viewer = await this.load();
    const before = viewer.getActiveView();
    const drd = viewer.getViews().find((v) => v.type === 'drd');
    if (drd && before !== drd) await viewer.open(drd);
    const svg = (await viewer.getActiveViewer()!.saveSVG()).svg;
    if (before && before !== drd) await viewer.open(before);
    return svg;
  }
}
