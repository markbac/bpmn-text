import { basename } from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import { compile } from './compile.js';
import { isPreviewable, Preview } from './preview.js';

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
    { documentSelector: [{ language: 'bpmnt' }, { language: 'dmnt' }] },
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
      if (xml !== undefined)
        await save(editor.document, 'bpmn', 'BPMN', Buffer.from(xml));
    }),
    vscode.commands.registerCommand('bpmnText.exportDmn', async () => {
      const editor = bpmnEditor();
      if (!editor) return;
      const { xml } = await compile(editor.document.getText(), {
        language: 'dmn',
      });
      if (xml !== undefined)
        await save(editor.document, 'dmn', 'DMN', Buffer.from(xml));
    }),
    vscode.commands.registerCommand('bpmnText.exportSvg', async () => {
      const editor = bpmnEditor();
      if (!editor) return;
      try {
        const svg = await preview.export(editor, 'svg');
        await save(editor.document, 'svg', 'SVG', Buffer.from(svg));
      } catch (error) {
        failed('SVG', error);
      }
    }),
    vscode.commands.registerCommand('bpmnText.exportPng', async () => {
      const editor = bpmnEditor();
      if (!editor) return;
      try {
        const data = await preview.export(editor, 'png');
        await save(editor.document, 'png', 'PNG', Buffer.from(data, 'base64'));
      } catch (error) {
        failed('PNG', error);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const enabled = vscode.workspace
        .getConfiguration('bpmnText')
        .get<boolean>('buildOnSave');
      // Only a .bpmnt or .dmnt file: anything else would be overwritten
      // by its build.
      const dmn = /\.dmnt$/i.test(document.uri.path);
      if (!enabled || !/\.(bpmnt|dmnt)$/i.test(document.uri.path)) return;
      if (!isPreviewable(document)) return;
      const compiled = await compile(document.getText(), {
        draw: 'without-errors',
        ...(dmn ? { language: 'dmn' as const } : {}),
      });
      if (compiled.xml === undefined) return;
      await vscode.workspace.fs.writeFile(
        document.uri.with({
          path: document.uri.path.replace(
            /\.(bpmnt|dmnt)$/i,
            dmn ? '.dmn' : '.bpmn',
          ),
        }),
        Buffer.from(compiled.xml),
      );
    }),
  );
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

function failed(label: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`bpmn-text: export ${label}: ${message}`);
}

function bpmnEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (isPreviewable(editor?.document)) return editor;
  void vscode.window.showInformationMessage(
    'Open a .bpmnt or .dmnt file first.',
  );
  return undefined;
}

/** Asks where to save, next to the source by default, and writes the file. */
async function save(
  document: vscode.TextDocument,
  extension: string,
  label: string,
  data: Uint8Array,
) {
  const name = basename(document.uri.path).replace(/\.(bpmnt|dmnt)$/i, '');
  const target = await vscode.window.showSaveDialog({
    defaultUri: document.uri.with({
      path: document.uri.path.replace(/[^/]*$/, `${name}.${extension}`),
    }),
    filters: { [label]: [extension] },
  });
  if (target) await vscode.workspace.fs.writeFile(target, data);
}
