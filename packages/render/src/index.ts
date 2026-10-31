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
    const svg = await page.evaluate(async (source) => {
      const page = globalThis as unknown as Page;
      page.viewer = new page.BpmnJS({ container: '#canvas' });
      await page.viewer.importXML(source);
      return (await page.viewer.saveSVG()).svg;
    }, xml);
    return { page, svg };
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
      } finally {
        await page.close();
      }
    },

    async close() {
      await browser.close();
    },
  };
}
