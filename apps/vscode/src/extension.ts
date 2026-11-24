import { basename } from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import { compile } from './compile.js';
import { Preview } from './preview.js';

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext) {
  const server = vscode.Uri.joinPath(
    context.extensionUri,
    'dist',
    'server.cjs',
  ).fsPath;
  client = new LanguageClient(
    'bpmnText',
    'bpmn-text',
    {
      run: { module: server, transport: TransportKind.ipc },
      debug: { module: server, transport: TransportKind.ipc },
    },
    { documentSelector: [{ language: 'bpmnt' }] },
  );
  void client.start();

  const preview = new Preview(context);
  context.subscriptions.push(
    preview,
    vscode.commands.registerCommand('bpmnText.openPreview', () => {
      const editor = bpmnEditor();
      if (editor) return preview.open(editor);
    }),
    vscode.commands.registerCommand('bpmnText.exportBpmn', async () => {
      const editor = bpmnEditor();
      if (!editor) return;
      const { xml } = await compile(editor.document.getText());
      await save(editor.document, 'bpmn', 'BPMN', Buffer.from(xml));
    }),
    vscode.commands.registerCommand('bpmnText.exportSvg', async () => {
      const editor = bpmnEditor();
      if (!editor) return;
      const svg = await preview.export(editor, 'svg');
      await save(editor.document, 'svg', 'SVG', Buffer.from(svg));
    }),
    vscode.commands.registerCommand('bpmnText.exportPng', async () => {
      const editor = bpmnEditor();
      if (!editor) return;
      const data = await preview.export(editor, 'png');
      await save(editor.document, 'png', 'PNG', Buffer.from(data, 'base64'));
    }),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const enabled = vscode.workspace
        .getConfiguration('bpmnText')
        .get<boolean>('buildOnSave');
      if (!enabled || document.languageId !== 'bpmnt') return;
      const compiled = await compile(document.getText());
      if (compiled.errors > 0) return;
      await vscode.workspace.fs.writeFile(
        document.uri.with({
          path: document.uri.path.replace(/\.bpmnt$/, '.bpmn'),
        }),
        Buffer.from(compiled.xml),
      );
    }),
  );
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

function bpmnEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId === 'bpmnt') return editor;
  void vscode.window.showInformationMessage('Open a .bpmnt file first.');
  return undefined;
}

/** Asks where to save, next to the source by default, and writes the file. */
async function save(
  document: vscode.TextDocument,
  extension: string,
  label: string,
  data: Uint8Array,
) {
  const name = basename(document.uri.path).replace(/\.bpmnt$/, '');
  const target = await vscode.window.showSaveDialog({
    defaultUri: document.uri.with({
      path: document.uri.path.replace(/[^/]*$/, `${name}.${extension}`),
    }),
    filters: { [label]: [extension] },
  });
  if (target) await vscode.workspace.fs.writeFile(target, data);
}
