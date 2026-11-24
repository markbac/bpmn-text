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
  private timer: NodeJS.Timeout | undefined;
  private shown: Promise<void> = Promise.resolve();
  private onShown: (() => void) | undefined;
  private exporting: ((data: string) => void) | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.document) this.schedule();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === 'bpmnt') this.follow(editor);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document === this.document)
          this.highlight(e.textEditor);
      }),
    );
  }

  /** Opens the preview beside `editor`, or shows the one that is open. */
  open(editor: vscode.TextEditor): Promise<void> {
    this.document = editor.document;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    } else {
      this.create();
    }
    this.schedule(0);
    return this.shown;
  }

  /** Draws the preview as an SVG, or as a PNG in base64. */
  async export(editor: vscode.TextEditor, format: 'svg' | 'png') {
    await this.open(editor);
    return new Promise<string>((resolve) => {
      this.exporting = resolve;
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
    this.shown = new Promise((resolve) => (this.onShown = resolve));
    panel.webview.html = html(panel.webview, dist);
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.document = undefined;
    });
    panel.webview.onDidReceiveMessage((m: FromWebview) => this.receive(m));
  }

  private receive(message: FromWebview) {
    if (message.type === 'shown') {
      this.onShown?.();
      const editor = this.editor();
      if (editor) this.highlight(editor);
    } else if (message.type === 'select') {
      this.select(message.id);
    } else if (message.type === 'exported') {
      this.exporting?.(message.data);
      this.exporting = undefined;
    } else {
      void vscode.window.showErrorMessage(
        `bpmn-text preview: ${message.message}`,
      );
    }
  }

  private editor(): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find(
      (e) => e.document === this.document,
    );
  }

  /** Shows another bpmn-text document in the open preview. */
  private follow(editor: vscode.TextEditor) {
    if (!this.panel || editor.document === this.document) return;
    this.document = editor.document;
    this.schedule(0);
  }

  private schedule(delay = DELAY_MS) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), delay);
  }

  private async update() {
    const document = this.document;
    if (!this.panel || !document) return;
    try {
      const compiled = await compile(document.getText());
      // Text that changed while compiling is drawn by the next update.
      if (document !== this.document || !compiled.xml) return;
      this.map = compiled.sourceMap;
      this.panel.title = `Preview ${vscode.workspace.asRelativePath(document.uri)}`;
      if (compiled.errors === 0 || !this.drawn) {
        this.drawn = true;
        await this.post({ type: 'show', xml: compiled.xml });
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `bpmn-text preview: ${String(error)}`,
      );
    }
  }

  private drawn = false;

  private post(message: ToWebview) {
    return this.panel?.webview.postMessage(message);
  }

  /** The cursor selects its element in the diagram. */
  private highlight(editor: vscode.TextEditor) {
    const offset = editor.document.offsetAt(editor.selection.active);
    void this.post({ type: 'highlight', id: elementAt(this.map, offset) });
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
  html, body, #diagram { height: 100%; margin: 0; padding: 0; background: #fff; }
  .djs-element.source-selected .djs-visual > :first-child {
    stroke: #d6336c !important;
    stroke-width: 3px !important;
  }
</style>
</head>
<body>
<div id="diagram"></div>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
}
