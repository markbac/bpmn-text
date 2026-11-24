import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FromWebview, ToWebview } from '../src/messages.js';

// The preview against a stand-in for the VS Code API and the compiler, so
// that the order of compiles, draws and exports can be controlled.

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(value: T) {
    for (const l of this.listeners) l(value);
  }
}

const vscode = vi.hoisted(() => {
  const panels: {
    title: string;
    posted: unknown[];
    receive?: ((m: unknown) => void) | undefined;
    dispose: () => void;
  }[] = [];
  return {
    panels,
    changeText: undefined as unknown,
    changeEditor: undefined as unknown,
    changeSelection: undefined as unknown,
    visibleTextEditors: [] as unknown[],
    errors: [] as string[],
  };
});

vi.mock('vscode', () => {
  const changeText = new Emitter<unknown>();
  const changeEditor = new Emitter<unknown>();
  const changeSelection = new Emitter<unknown>();
  vscode.changeText = changeText;
  vscode.changeEditor = changeEditor;
  vscode.changeSelection = changeSelection;
  return {
    ViewColumn: { Beside: -2 },
    TextEditorRevealType: { InCenter: 2 },
    Uri: { joinPath: (_: unknown, ...parts: string[]) => parts.join('/') },
    workspace: {
      onDidChangeTextDocument: changeText.event,
      asRelativePath: (uri: { path: string }) => uri.path,
    },
    window: {
      onDidChangeActiveTextEditor: changeEditor.event,
      onDidChangeTextEditorSelection: changeSelection.event,
      get visibleTextEditors() {
        return vscode.visibleTextEditors;
      },
      showErrorMessage: (m: string) => vscode.errors.push(m),
      createWebviewPanel: () => {
        const disposed = new Emitter<void>();
        const panel = {
          title: '',
          posted: [] as unknown[],
          receive: undefined as ((m: unknown) => void) | undefined,
          reveal: () => undefined,
          onDidDispose: disposed.event,
          dispose: () => disposed.fire(),
          webview: {
            html: '',
            cspSource: 'csp',
            asWebviewUri: (u: unknown) => u,
            postMessage: (m: unknown) => {
              panel.posted.push(m);
              return Promise.resolve(true);
            },
            onDidReceiveMessage: (l: (m: unknown) => void) => {
              panel.receive = l;
            },
          },
        };
        vscode.panels.push(panel);
        return panel;
      },
    },
  };
});

/** Compiles finish when the test says so, in any order. */
const compiles: {
  source: string;
  /** Whether the caller wanted a diagram even with errors. */
  always: boolean;
  finish: (errors?: number) => void;
}[] = [];

vi.mock('../src/compile.js', () => ({
  compile: (source: string, options: { draw?: string } = {}) =>
    new Promise((resolve) => {
      const always = options.draw !== 'without-errors';
      compiles.push({
        source,
        always,
        finish: (errors = 0) =>
          resolve({
            xml: errors && !always ? undefined : `<xml>${source}</xml>`,
            sourceMap: {},
            errors,
          }),
      });
    }),
}));

const { Preview } = await import('../src/preview.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

function editor(path: string, text: string) {
  const document = {
    uri: { path },
    languageId: 'bpmnt',
    getText: () => text,
    offsetAt: () => 0,
  };
  return { document, selection: { active: 0 }, viewColumn: 1 };
}

const panel = () => vscode.panels.at(-1)!;
const posted = () => panel().posted as ToWebview[];
const shows = () => posted().flatMap((m) => (m.type === 'show' ? [m.xml] : []));
const reply = (m: FromWebview) => panel().receive!(m);

/** Finishes the pending compile and lets the webview draw it. */
async function draw(errors = 0) {
  compiles.shift()!.finish(errors);
  await flush();
  reply({ type: 'shown' });
  await flush();
}

let preview: InstanceType<typeof Preview>;

beforeEach(() => {
  compiles.length = 0;
  vscode.panels.length = 0;
  vscode.errors.length = 0;
  preview = new Preview({ extensionUri: 'ext' } as never);
});

afterEach(() => preview.dispose());

describe('the preview (FR-52)', () => {
  it('exports the document asked for, not the one shown before', async () => {
    const a = editor('/a.bpmnt', 'A');
    const b = editor('/b.bpmnt', 'B');
    void preview.open(a as never);
    await draw();

    const exported = preview.export(b as never, 'svg');
    await flush();
    expect(posted().some((m) => m.type === 'export')).toBe(false);
    await draw();
    const last = posted().at(-1);
    expect(last).toEqual({ type: 'export', format: 'svg' });
    expect(shows().at(-1)).toBe('<xml>B</xml>');

    reply({ type: 'exported', format: 'svg', data: '<svg/>' });
    await expect(exported).resolves.toBe('<svg/>');
  });

  it('fails an export the webview could not make', async () => {
    void preview.open(editor('/a.bpmnt', 'A') as never);
    await draw();
    const exported = preview.export(editor('/a.bpmnt', 'A') as never, 'png');
    await draw();
    reply({ type: 'failed', during: 'export', message: 'no canvas' });
    await expect(exported).rejects.toThrow('no canvas');
  });

  it('fails an export when the preview is closed', async () => {
    const a = editor('/a.bpmnt', 'A');
    void preview.open(a as never);
    await draw();
    const exported = preview.export(a as never, 'svg');
    await draw();
    panel().dispose();
    await expect(exported).rejects.toThrow('closed');
  });

  it('draws a newly followed document even while it has errors', async () => {
    void preview.open(editor('/a.bpmnt', 'A') as never);
    await draw();
    (vscode.changeEditor as Emitter<unknown>).fire(editor('/b.bpmnt', 'B!'));
    await draw(1);
    expect(shows().at(-1)).toBe('<xml>B!</xml>');
    expect(panel().title).toBe('Preview /b.bpmnt');
  });

  it('draws a document with errors in a reopened preview', async () => {
    const a = editor('/a.bpmnt', 'A!');
    void preview.open(a as never);
    await draw(1);
    panel().dispose();
    void preview.open(a as never);
    await draw(1);
    expect(shows()).toEqual(['<xml>A!</xml>']);
  });

  it('compiles one version at a time, skipping stale ones', async () => {
    const a = editor('/a.bpmnt', 'A');
    void preview.open(a as never);
    await draw();
    let current = 'A1';
    a.document.getText = () => current;
    void preview.open(a as never);
    current = 'A2';
    void preview.open(a as never);
    current = 'A3';
    void preview.open(a as never);
    // A1 is compiling; A2 is skipped, and A3 waits for A1.
    expect(compiles.map((c) => c.source)).toEqual(['A1']);
    compiles.shift()!.finish();
    await flush();
    expect(compiles.map((c) => c.source)).toEqual(['A3']);
    await draw();
    expect(shows()).toEqual(['<xml>A</xml>', '<xml>A3</xml>']);
  });

  it('lays out text with errors only while nothing is drawn', async () => {
    const a = editor('/a.bpmnt', 'A!');
    void preview.open(a as never);
    expect(compiles[0]!.always).toBe(true);
    await draw(1);
    void preview.open(a as never);
    expect(compiles[0]!.always).toBe(false);
    await draw(1);
    expect(shows()).toEqual(['<xml>A!</xml>']);
  });

  it('does not redraw a diagram that has not changed', async () => {
    const a = editor('/a.bpmnt', 'A');
    void preview.open(a as never);
    await draw();
    void preview.open(a as never);
    await draw();
    expect(shows()).toEqual(['<xml>A</xml>']);
  });
});
