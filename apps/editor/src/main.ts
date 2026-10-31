import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import './style.css';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history as undoHistory,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { lintGutter, lintKeymap, setDiagnostics } from '@codemirror/lint';
import { EditorSelection, EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import NavigatedViewerModule from 'bpmn-js/lib/NavigatedViewer.js';
import type { Compiled } from './compile.js';
import { Compiler } from './compiler.js';
import { bpmnText, completionSource } from './language.js';
import { toLint } from './lint.js';
import { fileName, shareHash, sourceFromHash, storage } from './share.js';
import { elementAt } from './sync.js';

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

// Examples (FR-44), bundled from the repository's examples/ folder.
const examples = Object.fromEntries(
  Object.entries(
    import.meta.glob('../../../examples/*.bpmnt', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).map(([path, text]) => [path.replace(/^.*\/|\.bpmnt$/g, ''), text]),
);
const DEFAULT_EXAMPLE = '04-collaboration';
const SAVED = 'bpmn-text:source';
const THEME = 'bpmn-text:theme';

// The diagram (FR-40): a bpmn-js viewer with zoom and pan.
interface Shape {
  id: string;
  businessObject?: { id: string };
}
interface Viewer {
  importXML(xml: string): Promise<unknown>;
  saveSVG(): Promise<{ svg: string }>;
  on(
    event: string,
    callback: (e: { element: Shape; originalEvent?: MouseEvent }) => void,
  ): void;
  get(name: 'canvas'): {
    viewbox(box?: object): {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    zoom(level: 'fit-viewport'): void;
    addMarker(id: string, marker: string): void;
    removeMarker(id: string, marker: string): void;
    scrollToElement(element: Shape): void;
  };
  get(name: 'elementRegistry'): { get(id: string): Shape | undefined };
}
// bpmn-js ships ES modules without `"type": "module"`, so TypeScript sees
// a CommonJS default here; the bundler gives the class itself.
const NavigatedViewer = NavigatedViewerModule as unknown as new (options: {
  container: string;
}) => Viewer;
const viewer = new NavigatedViewer({ container: '#diagram' });
const canvas = viewer.get('canvas');
const registry = viewer.get('elementRegistry');

let last: Compiled | undefined;
/** The XML on screen: the last compile that had no errors, or the first. */
let shown: string | undefined;
let fit = true;
let highlighted: string | undefined;
/** Set while the diagram moves the cursor, so the cursor does not echo back. */
let fromDiagram = false;

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)', fontWeight: '600' },
  { tag: tags.typeName, color: 'var(--syntax-type)' },
  { tag: tags.string, color: 'var(--syntax-string)' },
  { tag: tags.docString, color: 'var(--syntax-doc)', fontStyle: 'italic' },
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: tags.operator, color: 'var(--syntax-operator)', fontWeight: '600' },
  { tag: tags.meta, color: 'var(--syntax-id)' },
  { tag: tags.labelName, color: 'var(--syntax-label)' },
  { tag: tags.attributeName, color: 'var(--syntax-attribute)' },
  { tag: tags.atom, color: 'var(--syntax-value)' },
]);

const view = new EditorView({
  parent: $('source'),
  state: EditorState.create({
    doc: initialSource(),
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      undoHistory(),
      drawSelection(),
      indentUnit.of('  '),
      EditorState.tabSize.of(2),
      bpmnText,
      syntaxHighlighting(highlight),
      autocompletion({
        override: [
          completionSource(() => ({
            names: last?.names ?? [],
            lanes: last?.lanes ?? [],
          })),
        ],
      }),
      lintGutter(),
      keymap.of([
        ...completionKeymap,
        ...lintKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const text = update.state.doc.toString();
          storage.set(SAVED, text);
          compiler.update(text);
        }
        if (update.selectionSet && !fromDiagram) cursorMoved();
      }),
    ],
  }),
});

// Live compile in a worker (FR-41).
const compiler = new Compiler(
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  showResult,
);
compiler.update(view.state.doc.toString(), true);

function initialSource(): string {
  return (
    sourceFromHash(location.hash) ??
    storage.get(SAVED) ??
    examples[DEFAULT_EXAMPLE] ??
    ''
  );
}

async function showResult(result: Compiled, source: string) {
  last = result;
  const current = view.state.doc.toString() === source;
  if (current) {
    view.dispatch(
      setDiagnostics(
        view.state,
        toLint(result.diagnostics, view.state.doc.length),
      ),
    );
  }
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  const warnings = result.diagnostics.filter((d) => d.severity === 'warning');
  $('status').textContent =
    `${errors.length} error${errors.length === 1 ? '' : 's'}, ` +
    `${warnings.length} warning${warnings.length === 1 ? '' : 's'} · ` +
    `compiled in ${result.ms} ms` +
    (errors.length && shown
      ? ' · showing the last diagram without errors'
      : '');
  // Keep the last good diagram while there are errors.
  if (!result.xml || (errors.length > 0 && shown)) return;
  if (result.xml === shown) return;
  const box = shown && !fit ? canvas.viewbox() : undefined;
  await viewer.importXML(result.xml);
  shown = result.xml;
  if (box)
    canvas.viewbox({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    });
  else canvas.zoom('fit-viewport');
  fit = false;
  highlighted = undefined;
  cursorMoved();
}

/** Loads new text, fitting the diagram to the view. */
function load(text: string) {
  fit = true;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: EditorSelection.cursor(0),
  });
  compiler.update(text, true);
}

// Selection sync (FR-43): the cursor highlights its element, and a click
// on an element selects its source.
function mark(id: string | undefined) {
  if (highlighted === id) return;
  if (highlighted && registry.get(highlighted))
    canvas.removeMarker(highlighted, 'source-selected');
  highlighted = id;
  if (id) canvas.addMarker(id, 'source-selected');
}

function cursorMoved() {
  if (!last) return;
  const offset = view.state.selection.main.head;
  mark(elementAt(last.sourceMap, offset, (id) => !!registry.get(id)));
}

viewer.on('element.click', ({ element }) => {
  const id = element.businessObject?.id ?? element.id;
  const range = last?.sourceMap[id];
  if (!range || !registry.get(id)) return;
  fromDiagram = true;
  const length = view.state.doc.length;
  view.dispatch({
    selection: EditorSelection.range(
      Math.min(range.start.offset, length),
      Math.min(range.end.offset, length),
    ),
    effects: EditorView.scrollIntoView(Math.min(range.start.offset, length), {
      y: 'center',
    }),
  });
  fromDiagram = false;
  mark(id);
  view.focus();
});

// Documentation tooltips (FR-15).
const tooltip = $('tooltip');
viewer.on('element.hover', ({ element, originalEvent }) => {
  const id = element.businessObject?.id ?? element.id;
  const text = last?.documentation[id];
  if (!text || !originalEvent) return;
  tooltip.textContent = text;
  const pane = tooltip.parentElement!.getBoundingClientRect();
  tooltip.style.left = `${originalEvent.clientX - pane.left + 12}px`;
  tooltip.style.top = `${originalEvent.clientY - pane.top + 12}px`;
  tooltip.hidden = false;
});
viewer.on('element.out', () => (tooltip.hidden = true));

// Examples.
const select = $<HTMLSelectElement>('examples');
for (const name of Object.keys(examples).sort()) {
  select.add(new Option(name.replace(/^\d+-/, '').replace(/-/g, ' '), name));
}
select.addEventListener('change', () => {
  const text = examples[select.value];
  if (text !== undefined) load(text);
  select.value = '';
});

// Share links.
$('share').addEventListener('click', async () => {
  const hash = shareHash(view.state.doc.toString());
  history.replaceState(null, '', hash);
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied');
  } catch {
    toast('Link is in the address bar');
  }
});
window.addEventListener('hashchange', () => {
  const text = sourceFromHash(location.hash);
  if (text !== undefined && text !== view.state.doc.toString()) load(text);
});

// Downloads.
const menu = $('download-menu');
$('download').addEventListener('click', () => (menu.hidden = !menu.hidden));
menu.addEventListener('click', async (event) => {
  const format = (event.target as HTMLElement).dataset.format;
  if (!format) return;
  menu.hidden = true;
  const source = view.state.doc.toString();
  const name = fileName(source);
  if (format === 'bpmnt')
    save(new Blob([source], { type: 'text/plain' }), `${name}.bpmnt`);
  if (format === 'bpmn' && shown)
    save(new Blob([shown], { type: 'application/xml' }), `${name}.bpmn`);
  if (format === 'svg' || format === 'png') {
    const { svg } = await viewer.saveSVG();
    if (format === 'svg')
      save(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
    else save(await png(svg), `${name}.png`);
  }
});

function save(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** The SVG drawn on a white canvas at twice its size. */
async function png(svg: string): Promise<Blob> {
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
  return new Promise((resolve) => c.toBlob((b) => resolve(b!), 'image/png'));
}

function toast(text: string) {
  const t = $('toast');
  t.textContent = text;
  setTimeout(() => (t.textContent = ''), 2500);
}

// Theme: the system's, unless chosen.
const root = document.documentElement;
const savedTheme = storage.get(THEME);
if (savedTheme) root.dataset.theme = savedTheme;
$('theme').addEventListener('click', () => {
  const dark =
    root.dataset.theme === 'dark' ||
    (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'light' : 'dark';
  storage.set(THEME, root.dataset.theme);
});

// Resizable split: side by side, or stacked on narrow screens.
const split = $('split');
const divider = $('divider');
const stacked = () => matchMedia('(max-width: 800px)').matches;
function setRatio(ratio: number) {
  const r = Math.min(0.85, Math.max(0.15, ratio));
  split.style.setProperty('--ratio', `${r * 100}%`);
}
divider.addEventListener('pointerdown', (event) => {
  divider.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => {
    const box = split.getBoundingClientRect();
    setRatio(
      stacked()
        ? (e.clientY - box.top) / box.height
        : (e.clientX - box.left) / box.width,
    );
  };
  divider.addEventListener('pointermove', move);
  divider.addEventListener(
    'pointerup',
    () => divider.removeEventListener('pointermove', move),
    { once: true },
  );
});
divider.addEventListener('keydown', (event) => {
  const current =
    parseFloat(split.style.getPropertyValue('--ratio') || '45') / 100;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
    setRatio(current - 0.05);
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
    setRatio(current + 0.05);
});

// For the end-to-end tests.
Object.assign(window, { bpmnTextEditor: { view, viewer } });
