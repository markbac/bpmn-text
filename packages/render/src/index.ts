import { createRequire } from 'node:module';
import type {
  Browser,
  BrowserContext,
  Page as PlaywrightPage,
} from 'playwright-core';

/** Thrown when headless Chromium cannot be started, with setup steps. */
export class RenderUnavailableError extends Error {
  override name = 'RenderUnavailableError';
}

export interface PngOptions {
  /** Pixels per diagram unit. Default 1. */
  scale?: number;
}

/** A decision table drawn as a picture. */
export interface TableImage {
  /** The decision's ID, such as `Decision_approve_loan`. */
  id: string;
  name: string;
  png: Uint8Array;
}

/**
 * Renders BPMN XML exactly as the editors draw it: bpmn-js in headless
 * Chromium (ADR-005); and DMN XML with dmn-js. One browser serves every
 * call; `close()` it when the batch is done.
 */
export interface Renderer {
  svg(xml: string): Promise<string>;
  png(xml: string, options?: PngOptions): Promise<Uint8Array>;
  /** The DRD of DMN XML, as SVG. */
  dmnSvg(xml: string): Promise<string>;
  /** The DRD of DMN XML, as PNG. */
  dmnPng(xml: string, options?: PngOptions): Promise<Uint8Array>;
  /**
   * Each decision table of DMN XML, as dmn-js shows it. dmn-js draws tables
   * as HTML, so they have no SVG form.
   */
  dmnTables(xml: string, options?: PngOptions): Promise<TableImage[]>;
  /** An SVG this package made, as PNG. */
  svgToPng(svg: string, options?: PngOptions): Promise<Uint8Array>;
  close(): Promise<void>;
}

const setup =
  'SVG and PNG output need playwright-core and headless Chromium. ' +
  'Install them with:\n\n' +
  '  npm install playwright-core\n' +
  '  npx playwright-core install chromium\n\n' +
  '.bpmn output works without them.';

const viewer = createRequire(import.meta.url).resolve(
  'bpmn-js/dist/bpmn-navigated-viewer.production.min.js',
);
const dmnRequire = createRequire(import.meta.url);
const dmnViewer = dmnRequire.resolve(
  'dmn-js/dist/dmn-viewer.production.min.js',
);
const dmnStyles = [
  'diagram-js.css',
  'dmn-js-shared.css',
  'dmn-js-drd.css',
  'dmn-js-decision-table.css',
  'dmn-js-literal-expression.css',
  'dmn-font/css/dmn-embedded.css',
].map((f) => dmnRequire.resolve(`dmn-js/dist/assets/${f}`));

/** An SVG element in the page, as far as this file uses it. */
interface Shape {
  style: { fill: string; stroke: string };
  querySelector(selector: string): Shape | null;
}

// The dmn-js viewer inside the page, and the parts of its API used here.
interface DmnView {
  type: string;
  element: { id: string; name?: string };
}
interface DmnPage {
  dmn: {
    importXML(xml: string): Promise<{ warnings: Error[] }>;
    getViews(): DmnView[];
    open(view: DmnView): Promise<unknown>;
    getActiveViewer(): {
      saveSVG?(): Promise<{ svg: string }>;
      get(name: string): unknown;
    };
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
  };
  DmnJS: new (options: { container: string }) => DmnPage['dmn'];
}

/** White space around the diagram in PNG output, in diagram units. */
const MARGIN = 20;

// The bpmn-js viewer inside the page. Its API is untyped here.
interface Page {
  viewer: {
    importXML(xml: string): Promise<{ warnings: Error[] }>;
    saveSVG(): Promise<{ svg: string }>;
  };
  BpmnJS: new (options: { container: string }) => Page['viewer'];
}

/**
 * Starts headless Chromium, or throws a `RenderUnavailableError`. The
 * browser is Playwright's own, or the one `BPMN_TEXT_CHROMIUM` names, such
 * as a Chromium already installed in a container.
 */
export async function createRenderer(): Promise<Renderer> {
  let browser: Browser;
  try {
    const { chromium } = await import('playwright-core');
    const executablePath = process.env.BPMN_TEXT_CHROMIUM;
    browser = await chromium.launch(executablePath ? { executablePath } : {});
  } catch (error) {
    throw new RenderUnavailableError(
      `${setup}\n\nCause: ${String(error).split('\n')[0]}`,
    );
  }
  const contexts = new Map<number, Promise<BrowserContext>>();

  async function newPage(scale: number) {
    let context = contexts.get(scale);
    if (!context) {
      context = browser.newContext({ deviceScaleFactor: scale });
      contexts.set(scale, context);
    }
    return (await context).newPage();
  }

  async function open(xml: string, scale: number) {
    const page = await newPage(scale);
    await page.setContent(
      '<style>html,body{margin:0;background:#fff}</style>' +
        '<div id="canvas" style="width:100vw;height:100vh"></div>',
    );
    await page.addScriptTag({ path: viewer });
    const svg = await page.evaluate(async (source) => {
      const page = globalThis as unknown as Page;
      page.viewer = new page.BpmnJS({ container: '#canvas' });
      await page.viewer.importXML(source);
      return (await page.viewer.saveSVG()).svg;
    }, xml);
    return { page, svg };
  }

  /** A page with dmn-js and `xml` imported, showing the DRD. */
  async function openDmn(xml: string, scale: number) {
    const page = await newPage(scale);
    await page.setViewportSize({ width: 4000, height: 3000 });
    await page.setContent(
      '<style>html,body{margin:0;background:#fff}' +
        // Tables shrink to fit, and the live viewer's controls are left
        // out of pictures, as the editors leave them out of exports.
        '.tjs-container{display:inline-block}' +
        '.view-drd,.bjs-powered-by,.powered-by{display:none!important}' +
        '</style><div id="canvas" style="width:100vw;height:100vh"></div>',
    );
    await page.addScriptTag({ path: dmnViewer });
    for (const path of dmnStyles) await page.addStyleTag({ path });
    await page.evaluate(async (source) => {
      const page = globalThis as unknown as DmnPage;
      page.dmn = new page.DmnJS({ container: '#canvas' });
      await page.dmn.importXML(source);
    }, xml);
    return page;
  }

  /** The DRD as SVG, with the colours written on shapes, which dmn-js does not draw. */
  async function drdSvg(page: PlaywrightPage) {
    return page.evaluate(async () => {
      const page = globalThis as unknown as DmnPage;
      const drd = page.dmn.getViews().find((v) => v.type === 'drd');
      if (!drd) throw new Error('The DMN XML has no DRD.');
      await page.dmn.open(drd);
      const viewer = page.dmn.getActiveViewer();
      const registry = viewer.get('elementRegistry') as {
        getGraphics(id: string): Shape | undefined;
      };
      const elements =
        page.dmn.getDefinitions().dmnDI?.diagrams?.[0]?.diagramElements ?? [];
      for (const e of elements) {
        const fill = e.$attrs?.['color:background-color'];
        const stroke = e.$attrs?.['color:border-color'];
        const id = e.dmnElementRef?.id;
        if ((!fill && !stroke) || !id) continue;
        const shape = registry
          .getGraphics(id)
          ?.querySelector('.djs-visual > :first-child') as Shape | null;
        if (!shape) continue;
        if (fill) shape.style.fill = fill;
        if (stroke) shape.style.stroke = stroke;
      }
      return (await viewer.saveSVG!()).svg;
    });
  }

  async function picture(page: PlaywrightPage, svg: string) {
    const size = (name: string) =>
      Number(new RegExp(`<svg[^>]* ${name}="([\\d.]+)"`).exec(svg)?.[1]);
    await page.setViewportSize({
      width: Math.ceil(size('width') + 2 * MARGIN),
      height: Math.ceil(size('height') + 2 * MARGIN),
    });
    await page.setContent(
      '<style>html,body{margin:0;background:#fff}' +
        `#image{display:inline-block;padding:${MARGIN}px;line-height:0}</style>` +
        `<div id="image">${svg.replace(/^<\?xml[^>]*>/, '')}</div>`,
    );
    return await page.locator('#image').screenshot({ type: 'png' });
  }

  return {
    async svg(xml) {
      const { page, svg } = await open(xml, 1);
      await page.close();
      return svg;
    },

    // Drawn from the exported SVG, as the editors export images, rather
    // than a screenshot of the viewer: the viewer shows the bpmn.io
    // watermark, which belongs to the live viewer, not to exported images.
    async png(xml, { scale = 1 } = {}) {
      const { page, svg } = await open(xml, scale);
      try {
        return await picture(page, svg);
      } finally {
        await page.close();
      }
    },

    async dmnSvg(xml) {
      const page = await openDmn(xml, 1);
      try {
        return await drdSvg(page);
      } finally {
        await page.close();
      }
    },

    async dmnPng(xml, { scale = 1 } = {}) {
      const page = await openDmn(xml, scale);
      try {
        return await picture(page, await drdSvg(page));
      } finally {
        await page.close();
      }
    },

    async dmnTables(xml, { scale = 1 } = {}) {
      const page = await openDmn(xml, scale);
      try {
        const views = await page.evaluate(() =>
          (globalThis as unknown as DmnPage).dmn
            .getViews()
            .filter((v) => v.type === 'decisionTable')
            .map((v) => ({ id: v.element.id, name: v.element.name ?? '' })),
        );
        const images: TableImage[] = [];
        for (const view of views) {
          await page.evaluate(async (id) => {
            const page = globalThis as unknown as DmnPage;
            const v = page.dmn
              .getViews()
              .find((x) => x.type === 'decisionTable' && x.element.id === id)!;
            await page.dmn.open(v);
          }, view.id);
          // The header and the table, not the container, which fills the page.
          const box = await page.evaluate(() => {
            const doc = globalThis as unknown as {
              document: {
                querySelector(s: string): {
                  getBoundingClientRect(): {
                    left: number;
                    top: number;
                    right: number;
                    bottom: number;
                  };
                } | null;
              };
            };
            const parts = ['.decision-table-properties', '.tjs-table']
              .map((s) => doc.document.querySelector(s))
              .filter((e) => e !== null)
              .map((e) => e.getBoundingClientRect());
            const x = Math.min(...parts.map((r) => r.left));
            const y = Math.min(...parts.map((r) => r.top));
            return {
              x,
              y,
              width: Math.max(...parts.map((r) => r.right)) - x,
              height: Math.max(...parts.map((r) => r.bottom)) - y,
            };
          });
          const png = await page.screenshot({ type: 'png', clip: box });
          images.push({ ...view, png });
        }
        return images;
      } finally {
        await page.close();
      }
    },

    async svgToPng(svg, { scale = 1 } = {}) {
      const page = await newPage(scale);
      try {
        return await picture(page, svg);
      } finally {
        await page.close();
      }
    },

    async close() {
      await browser.close();
    },
  };
}
