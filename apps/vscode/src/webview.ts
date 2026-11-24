import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import NavigatedViewerModule from 'bpmn-js/lib/NavigatedViewer.js';
import type { FromWebview, ToWebview } from './messages.js';

// The preview: a bpmn-js viewer with zoom and pan, driven by the extension.

interface Viewer {
  importXML(xml: string): Promise<unknown>;
  saveSVG(): Promise<{ svg: string }>;
  on(
    event: 'element.click',
    handler: (e: {
      element: { id: string; businessObject?: { id?: string } };
    }) => void,
  ): void;
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
  get(name: 'elementRegistry'): { get(id: string): unknown };
}

declare function acquireVsCodeApi(): {
  postMessage(message: FromWebview): void;
};

const vscode = acquireVsCodeApi();
// bpmn-js ships ES modules without `"type": "module"`, so TypeScript sees
// the module object, not the class.
const viewer = new (
  NavigatedViewerModule as unknown as new (options: {
    container: string;
  }) => Viewer
)({ container: '#diagram' });
const canvas = viewer.get('canvas');
const registry = viewer.get('elementRegistry');

let highlighted: string | undefined;
let pending: string | undefined;
let first = true;

function mark(id: string | undefined) {
  if (highlighted && registry.get(highlighted))
    canvas.removeMarker(highlighted, 'source-selected');
  highlighted = id && registry.get(id) ? id : undefined;
  if (highlighted) canvas.addMarker(highlighted, 'source-selected');
}

async function show(xml: string) {
  // Keeps the zoom and scroll across updates, fitting only the first.
  const box = first ? undefined : canvas.viewbox();
  await viewer.importXML(xml);
  if (box) canvas.viewbox(box);
  else canvas.zoom('fit-viewport');
  first = false;
  mark(pending);
  vscode.postMessage({ type: 'shown' });
}

/** The SVG drawn on a white canvas at twice its size, as base64. */
async function png(svg: string): Promise<string> {
  const image = new Image();
  image.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await image.decode();
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = image.width * scale;
  c.height = image.height * scale;
  const context = c.getContext('2d')!;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, c.width, c.height);
  context.drawImage(image, 0, 0, c.width, c.height);
  URL.revokeObjectURL(image.src);
  return c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

viewer.on('element.click', ({ element }) => {
  const id = element.businessObject?.id ?? element.id;
  if (registry.get(id)) vscode.postMessage({ type: 'select', id });
});

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  if (message.type === 'show') {
    show(message.xml).catch((error: unknown) =>
      vscode.postMessage({ type: 'failed', message: String(error) }),
    );
  } else if (message.type === 'highlight') {
    pending = message.id;
    mark(message.id);
  } else {
    viewer
      .saveSVG()
      .then(async ({ svg }) =>
        vscode.postMessage({
          type: 'exported',
          format: message.format,
          data: message.format === 'svg' ? svg : await png(svg),
        }),
      )
      .catch((error: unknown) =>
        vscode.postMessage({ type: 'failed', message: String(error) }),
      );
  }
});
