import 'dmn-js/dist/assets/dmn-js-shared.css';
import 'dmn-js/dist/assets/dmn-js-drd.css';
import 'dmn-js/dist/assets/dmn-js-decision-table.css';
import 'dmn-js/dist/assets/dmn-js-literal-expression.css';
import 'dmn-js/dist/assets/dmn-font/css/dmn-embedded.css';
import DmnViewerModule from 'dmn-js/lib/Viewer.js';

// The DMN preview in the webview (#82): the DRD, or the table or literal of
// the decision under the cursor, as the web editor shows them.

interface View {
  type: string;
  element: { id: string };
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
  get(name: 'eventBus'): {
    on(
      event: 'element.click',
      handler: (e: {
        element: { id: string; businessObject?: { id?: string } };
      }) => void,
    ): void;
  };
  saveSVG(): Promise<{ svg: string }>;
}
interface Viewer {
  importXML(xml: string): Promise<unknown>;
  getViews(): View[];
  getActiveView(): View | undefined;
  open(view: View): Promise<unknown>;
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

const SELECTED = 'source-selected';

export class DmnView {
  private readonly viewer: Viewer;
  private readonly wired = new WeakSet<object>();
  private decision: string | undefined;
  private marked: string | undefined;
  private first = true;

  constructor(
    private readonly container: HTMLElement,
    private readonly select: (id: string) => void,
  ) {
    this.viewer = new (
      DmnViewerModule as unknown as new (options: {
        container: HTMLElement;
      }) => Viewer
    )({ container });
    container.addEventListener('click', (event) => {
      const id = (event.target as Element)
        .closest('[data-element-id]')
        ?.getAttribute('data-element-id');
      if (id) select(id);
    });
  }

  private drd(): DrdViewer | undefined {
    return this.viewer.getActiveView()?.type === 'drd'
      ? this.viewer.getActiveViewer()
      : undefined;
  }

  /** The DRD is open: wire its clicks and draw the colours on shapes. */
  private drdOpened(fit: boolean, box?: object) {
    const drd = this.drd();
    if (!drd) return;
    if (!this.wired.has(drd)) {
      this.wired.add(drd);
      drd.get('eventBus').on('element.click', ({ element }) => {
        this.select(element.businessObject?.id ?? element.id);
      });
    }
    const registry = drd.get('elementRegistry');
    for (const e of this.viewer.getDefinitions().dmnDI?.diagrams?.[0]
      ?.diagramElements ?? []) {
      const id = e.dmnElementRef?.id;
      const fill = e.$attrs?.['color:background-color'];
      const stroke = e.$attrs?.['color:border-color'];
      const shape =
        id &&
        registry
          .getGraphics(id)
          ?.querySelector<SVGElement>('.djs-visual > :first-child');
      if (!shape) continue;
      if (fill) shape.style.fill = fill;
      if (stroke) shape.style.stroke = stroke;
    }
    if (box) drd.get('canvas').viewbox(box);
    else if (fit) drd.get('canvas').zoom('fit-viewport');
  }

  async show(xml: string): Promise<void> {
    const drd = this.drd();
    const box = this.first || !drd ? undefined : drd.get('canvas').viewbox();
    await this.viewer.importXML(xml);
    this.marked = undefined;
    this.drdOpened(true, box);
    this.first = false;
    const reopen = this.decision;
    this.decision = undefined;
    if (reopen) await this.focus(reopen, undefined);
  }

  /** Opens `decision`'s table or literal, or the DRD, and marks `id`. */
  async focus(decision: string | undefined, id: string | undefined) {
    if (decision !== this.decision) {
      const view = this.viewer
        .getViews()
        .find((v) =>
          decision
            ? v.element.id === decision && v.type !== 'drd'
            : v.type === 'drd',
        );
      if (view && view !== this.viewer.getActiveView()) {
        await this.viewer.open(view);
        this.marked = undefined;
        this.drdOpened(true);
      }
      this.decision = view ? decision : undefined;
    }
    if (this.marked === id) return;
    const drd = this.drd();
    if (this.marked && drd?.get('elementRegistry').get(this.marked))
      drd.get('canvas').removeMarker(this.marked, SELECTED);
    for (const e of this.container.querySelectorAll(`.${SELECTED}`))
      e.classList.remove(SELECTED);
    this.marked = id;
    if (!id) return;
    if (drd?.get('elementRegistry').get(id)) {
      drd.get('canvas').addMarker(id, SELECTED);
      return;
    }
    for (const e of this.container.querySelectorAll(
      `[data-element-id="${CSS.escape(id)}"]`,
    ))
      e.classList.add(SELECTED);
  }

  /** The DRD as SVG, whichever view is open. */
  async drdSvg(): Promise<string> {
    const before = this.viewer.getActiveView();
    const drd = this.viewer.getViews().find((v) => v.type === 'drd');
    if (drd && before !== drd) {
      await this.viewer.open(drd);
      this.drdOpened(true);
    }
    const { svg } = await this.viewer.getActiveViewer()!.saveSVG();
    if (before && drd && before !== drd) await this.viewer.open(before);
    return svg;
  }
}
