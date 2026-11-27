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
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { composeLegend, type Legend } from '@bpmn-text/bpmn';
import { format } from '@bpmn-text/core';
import { formatDmn } from '@bpmn-text/dmn';
import NavigatedViewerModule from 'bpmn-js/lib/NavigatedViewer.js';
import type { Compiled, Language } from './compile.js';
import { Compiler } from './compiler.js';
import { dmnCompletionSource, dmnText } from './dmn-language.js';
import { DmnPreview } from './dmn-preview.js';
import { bpmnText, completionSource } from './language.js';
import { toLint } from './lint.js';
import { nextCell } from './table.js';
import {
  fileName,
  languageFromHash,
  shareHash,
  sourceFromHash,
  storage,
} from './share.js';
import { elementAt } from './sync.js';

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

// Examples (FR-44), bundled from the repository's examples/ folders.
const bundled = (files: Record<string, string>, language: Language) =>
  Object.entries(files).map(
    ([path, text]) =>
      [
        `${language}:${path.replace(/^.*\/|\.(bpmnt|dmnt)$/g, '')}`,
        text,
      ] as const,
  );
const examples = Object.fromEntries([
  ...bundled(
    import.meta.glob('../../../examples/*.bpmnt', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
    'bpmn',
  ),
  ...bundled(
    import.meta.glob('../../../examples/dmn/*.dmnt', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
    'dmn',
  ),
]);
const DEFAULT_EXAMPLE: Record<Language, string> = {
  bpmn: 'bpmn:04-collaboration',
  dmn: 'dmn:02-dinner',
};
const SAVED: Record<Language, string> = {
  bpmn: 'bpmn-text:source',
  dmn: 'bpmn-text:source:dmn',
};
const LANGUAGE = 'bpmn-text:language';
const THEME = 'bpmn-text:theme';
const EXTENSION: Record<Language, string> = { bpmn: 'bpmnt', dmn: 'dmnt' };

// The diagram (FR-40): a bpmn-js viewer with zoom and pan.
interface Shape {
  id: string;
  businessObject?: { id: string };
}
interface Viewer {
  importXML(xml: string): Promise<unknown>;
  saveSVG(): Promise<{ svg: string }>;
  destroy(): void;
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
  container: string | HTMLElement;
}) => Viewer;
const viewer = new NavigatedViewer({ container: '#diagram' });
const canvas = viewer.get('canvas');
const registry = viewer.get('elementRegistry');

let language: Language = initialLanguage();
let last: Compiled | undefined;
/** The XML on screen: the last compile that had no errors, or the first. */
let shown: string | undefined;
let shownLegend: Legend | undefined;
let fit = true;
let highlighted: string | undefined;
/** Set while the diagram moves the cursor, so the cursor does not echo back. */
let fromDiagram = false;

// DMN (#79): dmn-js, loaded the first time a .dmnt file is shown.
const dmn = new DmnPreview($('dmn'), {
  onSelect: (id) => selectSource(id),
  onHover: (id, event) => showTooltip(id, event),
  onOut: () => (tooltip.hidden = true),
});

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
  { tag: tags.number, color: 'var(--syntax-value)' },
  { tag: tags.punctuation, color: 'var(--syntax-comment)' },
]);

/** The highlighter and completion of the current notation. */
const notation = new Compartment();
const notationExtensions = (l: Language) =>
  l === 'dmn'
    ? [
        dmnText,
        autocompletion({
          override: [dmnCompletionSource(() => ({ names: last?.names ?? [] }))],
        }),
      ]
    : [
        bpmnText,
        autocompletion({
          override: [
            completionSource(() => ({
              names: last?.names ?? [],
              lanes: last?.lanes ?? [],
            })),
          ],
        }),
      ];

/** Rewrites the source in canonical style; in DMN, this realigns tables. */
function formatDocument(target: EditorView): boolean {
  const text = target.state.doc.toString();
  const formatted = language === 'dmn' ? formatDmn(text) : format(text);
  if (formatted !== text)
    target.dispatch({
      changes: { from: 0, to: target.state.doc.length, insert: formatted },
    });
  return true;
}

/** Tab and Shift-Tab move between the cells of a DMN table row. */
const tableKeys = (back: boolean) => (target: EditorView) => {
  if (language !== 'dmn') return false;
  const head = target.state.selection.main.head;
  const line = target.state.doc.lineAt(head);
  const to = nextCell(line.text, head - line.from, back);
  if (to === undefined) return false;
  target.dispatch({
    selection: EditorSelection.range(line.from + to.from, line.from + to.to),
  });
  return true;
};

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
      notation.of(notationExtensions(language)),
      syntaxHighlighting(highlight),
      lintGutter(),
      keymap.of([
        { key: 'Tab', run: tableKeys(false) },
        { key: 'Shift-Tab', run: tableKeys(true) },
        { key: 'Shift-Alt-f', run: formatDocument },
        ...completionKeymap,
        ...lintKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const text = update.state.doc.toString();
          storage.set(SAVED[language], text);
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
compiler.language = language;
showLanguage();
compiler.update(view.state.doc.toString(), true);

function initialLanguage(): Language {
  const fromHash = languageFromHash(location.hash);
  if (fromHash) return fromHash;
  return storage.get(LANGUAGE) === 'dmn' ? 'dmn' : 'bpmn';
}

function initialSource(): string {
  return (
    sourceFromHash(location.hash) ??
    storage.get(SAVED[language]) ??
    examples[DEFAULT_EXAMPLE[language]] ??
    ''
  );
}

/** Shows the pane, menu entries and selector of the current notation. */
function showLanguage() {
  document.body.dataset.language = language;
  $<HTMLSelectElement>('language').value = language;
  $('diagram').hidden = language !== 'bpmn';
  $('dmn').hidden = language !== 'dmn';
  for (const b of document.querySelectorAll<HTMLElement>('[data-only]'))
    b.hidden = b.dataset.only !== language;
}

/** Switches notation, loading `text` or the last text written in it. */
function setLanguage(next: Language, text?: string) {
  if (next !== language) {
    language = next;
    storage.set(LANGUAGE, language);
    compiler.language = language;
    last = undefined;
    shown = undefined;
    highlighted = undefined;
    view.dispatch({
      effects: notation.reconfigure(notationExtensions(language)),
    });
    showLanguage();
  }
  load(
    text ??
      storage.get(SAVED[language]) ??
      examples[DEFAULT_EXAMPLE[language]] ??
      '',
  );
}

async function showResult(result: Compiled, source: string) {
  if (result.language !== language) return;
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
  if (result.language === 'dmn') {
    await dmn.show(result.xml, fit);
    shown = result.xml;
    fit = false;
    cursorMoved();
    return;
  }
  const box = shown && !fit ? canvas.viewbox() : undefined;
  await viewer.importXML(result.xml);
  shown = result.xml;
  shownLegend = result.legend;
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
  if (last.language === 'dmn') {
    if (!shown) return;
    // The decision the cursor is in, if its logic has a view of its own.
    const decision = last.decisions?.find(
      (d) =>
        d.logic &&
        d.range.start.offset <= offset &&
        offset <= d.range.end.offset,
    );
    void dmn.focus(
      decision?.id,
      elementAt(last.sourceMap, offset, () => true),
    );
    return;
  }
  mark(elementAt(last.sourceMap, offset, (id) => !!registry.get(id)));
}

/** Selects the source of element `id`, as a click on it does. */
function selectSource(id: string): boolean {
  const range = last?.sourceMap[id];
  if (!range) return false;
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
  view.focus();
  return true;
}

viewer.on('element.click', ({ element }) => {
  const id = element.businessObject?.id ?? element.id;
  if (!registry.get(id) || !selectSource(id)) return;
  mark(id);
});

// Documentation tooltips (FR-15).
const tooltip = $('tooltip');
function showTooltip(id: string, event: MouseEvent | undefined) {
  const text = last?.documentation[id];
  if (!text || !event) return;
  tooltip.textContent = text;
  const pane = tooltip.parentElement!.getBoundingClientRect();
  tooltip.style.left = `${event.clientX - pane.left + 12}px`;
  tooltip.style.top = `${event.clientY - pane.top + 12}px`;
  tooltip.hidden = false;
}
viewer.on('element.hover', ({ element, originalEvent }) =>
  showTooltip(element.businessObject?.id ?? element.id, originalEvent),
);
viewer.on('element.out', () => (tooltip.hidden = true));

// Notation and examples.
$<HTMLSelectElement>('language').addEventListener('change', (event) => {
  setLanguage((event.target as HTMLSelectElement).value as Language);
});
const select = $<HTMLSelectElement>('examples');
for (const l of ['bpmn', 'dmn'] as const) {
  const group = document.createElement('optgroup');
  group.label = l.toUpperCase();
  for (const key of Object.keys(examples).sort()) {
    if (!key.startsWith(`${l}:`)) continue;
    const name = key.slice(l.length + 1);
    group.append(new Option(name.replace(/^\d+-/, '').replace(/-/g, ' '), key));
  }
  select.add(group);
}
select.addEventListener('change', () => {
  const text = examples[select.value];
  const l = select.value.split(':')[0] as Language;
  if (text !== undefined) setLanguage(l, text);
  select.value = '';
});

// Share links.
$('share').addEventListener('click', async () => {
  const hash = shareHash(view.state.doc.toString(), language);
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
  const l = languageFromHash(location.hash);
  if (text !== undefined && l && text !== view.state.doc.toString())
    setLanguage(l, text);
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
  if (format === 'source')
    save(
      new Blob([source], { type: 'text/plain' }),
      `${name}.${EXTENSION[language]}`,
    );
  if (format === 'xml' && shown)
    save(new Blob([shown], { type: 'application/xml' }), `${name}.${language}`);
  if (format === 'svg' || format === 'png') {
    const svg =
      language === 'dmn' ? await dmn.drdSvg() : (await viewer.saveSVG()).svg;
    if (format === 'svg')
      save(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
    else save(await png(svg), `${name}.png`);
  }
  if ((format === 'key-svg' || format === 'key-png') && shownLegend) {
    const svg = await keyImage(shownLegend);
    if (format === 'key-svg')
      save(new Blob([svg], { type: 'image/svg+xml' }), `${name}.legend.svg`);
    else save(await png(svg), `${name}.legend.png`);
  }
});
$('format').addEventListener('click', () => formatDocument(view));

/** Draws the symbols of a key off screen, where the diagram stays as it is. */
async function keyImage(key: Legend): Promise<string> {
  const container = document.createElement('div');
  container.style.cssText =
    'position:absolute;left:-10000px;width:1000px;height:1000px';
  document.body.append(container);
  const drawer = new NavigatedViewer({ container });
  try {
    await drawer.importXML(key.xml);
    return composeLegend(key, (await drawer.saveSVG()).svg);
  } finally {
    drawer.destroy();
    container.remove();
  }
}

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
Object.assign(window, {
  bpmnTextEditor: {
    view,
    viewer,
    dmn,
    get last() {
      return last;
    },
  },
});
