import { elementAt, type Range } from '@bpmn-text/core';
import * as vscode from 'vscode';
import { compile } from './compile.js';
import type { FromWebview, ToWebview } from './messages.js';

const DELAY_MS = 150;

/**
 * The live preview (FR-52): a panel beside the editor that shows the
 * document, redrawn as it changes. While the text has errors the last
 * diagram without errors stays, and the cursor and the diagram select
 * each other.
 */
export class Preview implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private document: vscode.TextDocument | undefined;
  private map: Record<string, Range> = {};
  /** DMN: the decisions with logic, for opening the one at the cursor. */
  private decisions: { id: string; range: Range }[] = [];
  private timer: NodeJS.Timeout | undefined;
  /** The diagram of `document` the panel shows, if any. */
  private shownXml: string | undefined;
  /** Counts updates, so that a compile of older text is never drawn. */
  private generation = 0;
  /** The compile that runs now: one at a time. */
  private running: Promise<void> | undefined;
  /** Whether the text changed while `running` compiled. */
  private again = false;
  /** The latest update, which resolves once it is drawn. */
  private latest: Promise<void> = Promise.resolve();
  /** Waiting for the webview to draw the last diagram posted. */
  private waiting: (() => void)[] = [];
  private exporting:
    | { resolve: (data: string) => void; reject: (error: Error) => void }
    | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.document) this.schedule();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (isPreviewable(editor?.document)) this.follow(editor!);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document === this.document)
          this.highlight(e.textEditor);
      }),
    );
  }

  /**
   * Opens the preview beside `editor`, or shows the one that is open.
   * Resolves once the document as it is now is drawn.
   */
  open(editor: vscode.TextEditor): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    } else {
      this.create();
    }
    this.show(editor.document);
    return this.settled();
  }

  /** Draws the preview of `editor` as an SVG, or as a PNG in base64. */
  async export(editor: vscode.TextEditor, format: 'svg' | 'png') {
    await this.open(editor);
    if (this.exporting) throw new Error('An export is already running.');
    return new Promise<string>((resolve, reject) => {
      this.exporting = { resolve, reject };
      void this.post({ type: 'export', format });
    });
  }

  dispose() {
    clearTimeout(this.timer);
    this.panel?.dispose();
    for (const s of this.subscriptions) s.dispose();
  }

  private create() {
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(
      'bpmnText.preview',
      'bpmn-text preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [dist] },
    );
    this.panel = panel;
    panel.webview.html = html(panel.webview, dist);
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      clearTimeout(this.timer);
      this.panel = undefined;
      this.document = undefined;
      this.shownXml = undefined;
      this.map = {};
      this.decisions = [];
      this.generation++;
      this.release();
      this.exporting?.reject(new Error('The preview was closed.'));
      this.exporting = undefined;
    });
    panel.webview.onDidReceiveMessage((m: FromWebview) => this.receive(m));
  }

  private receive(message: FromWebview) {
    if (message.type === 'shown') {
      this.release();
      const editor = this.editor();
      if (editor) this.highlight(editor);
    } else if (message.type === 'select') {
      this.select(message.id);
    } else if (message.type === 'exported') {
      this.exporting?.resolve(message.data);
      this.exporting = undefined;
    } else if (message.during === 'export') {
      this.exporting?.reject(new Error(message.message));
      this.exporting = undefined;
    } else {
      // A diagram that could not be drawn: stop waiting for it, and draw
      // the next one even if it is the same.
      this.shownXml = undefined;
      this.release();
      void vscode.window.showErrorMessage(
        `bpmn-text preview: ${message.message}`,
      );
    }
  }

  /** Lets everything waiting for the last diagram carry on. */
  private release() {
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) resolve();
  }

  private editor(): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find(
      (e) => e.document === this.document,
    );
  }

  /** Shows another bpmn-text document in the open preview. */
  private follow(editor: vscode.TextEditor) {
    if (!this.panel || editor.document === this.document) return;
    this.show(editor.document);
  }

  /** Switches to `document`, drawing it now. */
  private show(document: vscode.TextDocument) {
    if (document !== this.document) {
      this.document = document;
      this.shownXml = undefined;
      this.map = {};
    }
    clearTimeout(this.timer);
    this.latest = this.update();
  }

  private schedule(delay = DELAY_MS) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.latest = this.update();
    }, delay);
  }

  /** Resolves once the latest update, and any that follow it, are drawn. */
  private async settled() {
    let latest;
    do {
      latest = this.latest;
      await latest;
    } while (latest !== this.latest);
  }

  /**
   * Compiles and draws the document. One compile runs at a time: text
   * that changes meanwhile is compiled once it ends, newest only.
   */
  private update(): Promise<void> {
    this.generation++;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const running = (async () => {
      do {
        this.again = false;
        await this.draw(this.generation);
      } while (this.again && this.panel);
    })();
    this.running = running;
    void running.finally(() => {
      if (this.running === running) this.running = undefined;
    });
    return running;
  }

  private async draw(generation: number) {
    const document = this.document;
    const panel = this.panel;
    if (!panel || !document) return;
    try {
      // While there are errors the last diagram stays, so only a document
      // not drawn yet needs its layout.
      const compiled = await compile(document.getText(), {
        draw: this.shownXml === undefined ? 'always' : 'without-errors',
        ...(document.languageId === 'dmnt' ? { language: 'dmn' } : {}),
      });
      // Newer text, or another document, is drawn instead.
      if (generation !== this.generation) return;
      this.map = compiled.sourceMap;
      this.decisions = compiled.decisions ?? [];
      panel.title = `Preview ${vscode.workspace.asRelativePath(document.uri)}`;
      if (compiled.xml === undefined || compiled.xml === this.shownXml) {
        // Nothing to redraw: the cursor may now be on another element.
        const editor = this.editor();
        if (editor) this.highlight(editor);
        return;
      }
      this.shownXml = compiled.xml;
      const shown = new Promise<void>((resolve) => this.waiting.push(resolve));
      await this.post({
        type: 'show',
        xml: compiled.xml,
        ...(document.languageId === 'dmnt' ? { language: 'dmn' } : {}),
      });
      await shown;
    } catch (error) {
      void vscode.window.showErrorMessage(
        `bpmn-text preview: ${String(error)}`,
      );
    }
  }

  private post(message: ToWebview) {
    return this.panel?.webview.postMessage(message);
  }

  /** The cursor selects its element in the diagram. */
  private highlight(editor: vscode.TextEditor) {
    const offset = editor.document.offsetAt(editor.selection.active);
    const decision = this.decisions.find(
      (d) => d.range.start.offset <= offset && offset <= d.range.end.offset,
    )?.id;
    void this.post({
      type: 'highlight',
      id: elementAt(this.map, offset),
      ...(decision ? { decision } : {}),
    });
  }

  /** A click on an element selects its source. */
  private select(id: string) {
    const range = this.map[id];
    const editor = this.editor();
    if (!range || !editor) return;
    const document = editor.document;
    const selection = new vscode.Selection(
      document.positionAt(range.start.offset),
      document.positionAt(range.end.offset),
    );
    editor.selection = selection;
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
    void vscode.window.showTextDocument(document, editor.viewColumn);
  }
}

/** Whether the preview can show a document: .bpmnt or .dmnt. */
export function isPreviewable(
  document: { languageId: string } | undefined,
): boolean {
  return document?.languageId === 'bpmnt' || document?.languageId === 'dmnt';
}

function html(webview: vscode.Webview, dist: vscode.Uri): string {
  const uri = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(dist, file));
  const nonce = Math.random().toString(36).slice(2);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} blob: data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('webview.css')}">
<style>
  html, body, #diagram, #dmn { height: 100%; margin: 0; padding: 0; background: #fff; }
  #dmn { overflow: auto; }
  [hidden] { display: none !important; }
  #dmn td.source-selected, #dmn tr.source-selected > td {
    outline: 2px solid #d6336c;
    outline-offset: -2px;
  }
  .djs-element.source-selected .djs-visual > :first-child {
    stroke: #d6336c !important;
    stroke-width: 3px !important;
  }
</style>
</head>
<body>
<div id="diagram"></div>
<div id="dmn" hidden></div>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
}
