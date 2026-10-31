import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRenderer } from '../src/index.js';

const xml = readFileSync(
  join(import.meta.dirname, '../../../examples/03-lanes.bpmn'),
  'utf8',
);
const renderer = createRenderer();
afterAll(async () => (await renderer).close());

/** Width and height from a PNG's IHDR chunk. */
const size = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset);
  return [view.getUint32(16), view.getUint32(20)];
};

describe('renderer', () => {
  it('renders SVG with bpmn-js', async () => {
    const svg = await (await renderer).svg(xml);
    expect(svg).toMatch(/^<\?xml[^>]*>\s*<!-- created with bpmn-js/);
    expect(svg).toContain('Inform team');
  });

  it('renders PNG at the requested scale, reusing the browser', async () => {
    const r = await renderer;
    const one = await r.png(xml);
    const two = await r.png(xml, { scale: 2 });
    expect([...one.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
    const [w1, h1] = size(one);
    const [w2, h2] = size(two);
    expect([w2, h2]).toEqual([w1! * 2, h1! * 2]);
  });

  it('draws PNG from the exported SVG, without the viewer watermark', async () => {
    const r = await renderer;
    const svg = await r.svg(xml);
    const attr = (name: string) =>
      Number(new RegExp(`<svg[^>]* ${name}="([\\d.]+)"`).exec(svg)![1]);
    // The exported SVG has no bpmn.io watermark; the PNG is that SVG plus
    // a 20px margin.
    expect(svg).not.toContain('bjs-powered-by');
    expect(size(await r.png(xml))).toEqual([
      Math.ceil(attr('width') + 40),
      Math.ceil(attr('height') + 40),
    ]);
  });
});
