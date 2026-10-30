// Spike (#3): lays out the hand-built models, then writes each one as
// .bpmn and as a PNG rendered by bpmn-js in headless Chromium, and prints a
// metrics table. Run from the repository root with Node 22.18 or later:
//
//   node packages/layout/spike/render.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { toXml } from './bpmn.ts';
import { collaboration, gateways, lanes } from './ir.ts';
import { layout } from './layout.ts';
import { measure } from './metrics.ts';

// The bpmn-js globals used inside the page. Its API is untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = { BpmnJS: new (options: object) => any; canvas: any };

const out = 'docs/spikes/lane-layout';
const models = {
  '02-gateways': gateways,
  '03-lanes': lanes,
  '04-collaboration': collaboration,
};
const viewer = createRequire(import.meta.url).resolve(
  'bpmn-js/dist/bpmn-navigated-viewer.production.min.js',
);

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const rows: string[] = [];
for (const [name, model] of Object.entries(models)) {
  const result = await layout(model);
  const xml = toXml(model, result);
  writeFileSync(`${out}/${name}.bpmn`, xml);
  const m = measure(model, result);
  rows.push(`| ${name} | ${Object.values(m).join(' | ')} |`);
  if (rows.length === 1) {
    rows.unshift(
      `| Example | ${Object.keys(m).join(' | ')} |`,
      `|---|${Object.keys(m)
        .map(() => '---')
        .join('|')}|`,
    );
  }

  // Render at 1:1 on a page sized to the diagram.
  const page = await browser.newPage({
    viewport: { width: 3000, height: 2000 },
  });
  await page.setContent(
    '<style>html,body{margin:0;background:#fff}</style><div id="c" style="width:100vw;height:100vh"></div>',
  );
  await page.addScriptTag({ path: viewer });
  const { warnings, box } = await page.evaluate(async (source) => {
    const page = globalThis as unknown as Page;
    const BpmnJS = page.BpmnJS;
    const v = new BpmnJS({ container: '#c' });
    const { warnings } = await v.importXML(source);
    page.canvas = v.get('canvas');
    const { x, y, width, height } = v.get('canvas').viewbox().inner;
    return {
      warnings: (warnings as Error[]).map((w) => w.message),
      box: { x, y, width, height },
    };
  }, xml);
  if (warnings.length) console.warn(name, warnings);
  const margin = 20;
  const width = Math.ceil(box.width + 2 * margin);
  const height = Math.ceil(box.height + 2 * margin);
  await page.setViewportSize({ width, height });
  await page.evaluate(
    ({ box, width, height, margin }) => {
      const { canvas } = globalThis as unknown as Page;
      canvas.resized();
      canvas.viewbox({ x: box.x - margin, y: box.y - margin, width, height });
    },
    { box, width, height, margin },
  );
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.close();
}
await browser.close();
console.log(rows.join('\n'));
