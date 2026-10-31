import { createRequire } from 'node:module';
import type { Browser, BrowserContext } from 'playwright-core';

/** Thrown when headless Chromium cannot be started, with setup steps. */
export class RenderUnavailableError extends Error {
  override name = 'RenderUnavailableError';
}

export interface PngOptions {
  /** Pixels per diagram unit. Default 1. */
  scale?: number;
}

/**
 * Renders BPMN XML exactly as the editors draw it: bpmn-js in headless
 * Chromium (ADR-005). One browser serves every call; `close()` it when
 * the batch is done.
 */
export interface Renderer {
  svg(xml: string): Promise<string>;
  png(xml: string, options?: PngOptions): Promise<Uint8Array>;
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
/** White space around the diagram in PNG output, in diagram units. */
const MARGIN = 20;

// The bpmn-js viewer inside the page. Its API is untyped here.
interface Page {
  viewer: {
    importXML(xml: string): Promise<{ warnings: Error[] }>;
    saveSVG(): Promise<{ svg: string }>;
    get(name: 'canvas'): {
      viewbox(box?: object): {
        inner: { x: number; y: number; width: number; height: number };
      };
      resized(): void;
    };
  };
  BpmnJS: new (options: { container: string }) => Page['viewer'];
}

/** Starts headless Chromium, or throws a `RenderUnavailableError`. */
export async function createRenderer(): Promise<Renderer> {
  let browser: Browser;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch();
  } catch (error) {
    throw new RenderUnavailableError(
      `${setup}\n\nCause: ${String(error).split('\n')[0]}`,
    );
  }
  const contexts = new Map<number, Promise<BrowserContext>>();

  async function open(xml: string, scale: number) {
    let context = contexts.get(scale);
    if (!context) {
      context = browser.newContext({ deviceScaleFactor: scale });
      contexts.set(scale, context);
    }
    const page = await (await context).newPage();
    await page.setContent(
      '<style>html,body{margin:0;background:#fff}</style>' +
        '<div id="canvas" style="width:100vw;height:100vh"></div>',
    );
    await page.addScriptTag({ path: viewer });
    const box = await page.evaluate(async (source) => {
      const page = globalThis as unknown as Page;
      page.viewer = new page.BpmnJS({ container: '#canvas' });
      await page.viewer.importXML(source);
      const { x, y, width, height } = page.viewer.get('canvas').viewbox().inner;
      return { x, y, width, height };
    }, xml);
    return { page, box };
  }

  return {
    async svg(xml) {
      const { page } = await open(xml, 1);
      try {
        return await page.evaluate(async () => {
          const { svg } = await (
            globalThis as unknown as Page
          ).viewer.saveSVG();
          return svg;
        });
      } finally {
        await page.close();
      }
    },

    async png(xml, { scale = 1 } = {}) {
      const { page, box } = await open(xml, scale);
      try {
        const width = Math.ceil(box.width + 2 * MARGIN);
        const height = Math.ceil(box.height + 2 * MARGIN);
        await page.setViewportSize({ width, height });
        await page.evaluate(
          ({ box, width, height, margin }) => {
            const canvas = (globalThis as unknown as Page).viewer.get('canvas');
            canvas.resized();
            canvas.viewbox({
              x: box.x - margin,
              y: box.y - margin,
              width,
              height,
            });
          },
          { box, width, height, margin: MARGIN },
        );
        return await page.screenshot({ type: 'png' });
      } finally {
        await page.close();
      }
    },

    async close() {
      await browser.close();
    },
  };
}
