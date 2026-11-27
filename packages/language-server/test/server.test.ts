import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { createConnection } from 'vscode-languageserver/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

// The language server end to end (#43, #46, #82): a JSON-RPC client talks
// to the real server over streams, as VS Code does over IPC.

interface PublishedDiagnostics {
  uri: string;
  diagnostics: {
    code: string;
    message: string;
    range: { start: { line: number } };
  }[];
}

let client: MessageConnection;
const published = new Map<string, PublishedDiagnostics['diagnostics']>();
const waiters: (() => void)[] = [];

beforeAll(async () => {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  startServer(
    createConnection(
      new StreamMessageReader(toServer),
      new StreamMessageWriter(toClient),
    ),
  );
  client = createMessageConnection(
    new StreamMessageReader(toClient),
    new StreamMessageWriter(toServer),
  );
  client.onNotification(
    'textDocument/publishDiagnostics',
    (p: PublishedDiagnostics) => {
      published.set(p.uri, p.diagnostics);
      waiters.splice(0).forEach((w) => w());
    },
  );
  client.listen();
  const result = (await client.sendRequest('initialize', {
    processId: null,
    rootUri: null,
    capabilities: {},
  })) as { capabilities: Record<string, unknown> };
  expect(result.capabilities.definitionProvider).toBe(true);
  await client.sendNotification('initialized', {});
});

afterAll(() => client?.dispose());

/** Opens a document and waits for its diagnostics. */
async function open(uri: string, languageId: string, text: string) {
  published.delete(uri);
  await client.sendNotification('textDocument/didOpen', {
    textDocument: { uri, languageId, version: 1, text },
  });
  while (!published.has(uri))
    await new Promise<void>((done) => waiters.push(done));
  return published.get(uri)!;
}

const dir = mkdtempSync(join(tmpdir(), 'bpmn-text-lsp-'));
const uri = (name: string) => pathToFileURL(join(dir, name)).href;
const loans = `input Credit score [type: number]

decision Approve loan [requires: Credit score]
  table
    | Credit score | -> Ok: boolean |
    | >= 700       | true           |
    | < 700        | false          |
`;

describe('language server over JSON-RPC', () => {
  it('publishes BPMN diagnostics with codes', async () => {
    const found = await open(uri('a.bpmnt'), 'bpmnt', 'start\n-> Nowhere\n');
    expect(found.map((d) => d.code)).toContain('BT202');
  });

  it('publishes DMN diagnostics, at the cell', async () => {
    const found = await open(
      uri('b.dmnt'),
      'dmnt',
      loans.replace('| < 700 ', '| <= 750'),
    );
    expect(found.map((d) => d.code)).toEqual(['BT530', 'BT530']);
    expect(found[0]!.range.start.line).toBe(5);
  });

  it('checks a rule task against the .dmnt files beside it, and goes to the decision', async () => {
    writeFileSync(join(dir, 'loans.dmnt'), loans);
    const process = 'start\nrule Decide [decision: Aprove loan]\nend\n';
    const found = await open(uri('p.bpmnt'), 'bpmnt', process);
    expect(found.map((d) => d.message)).toContain(
      'There is no decision called `Aprove loan`. Did you mean `Approve loan`?',
    );
    await open(
      uri('q.bpmnt'),
      'bpmnt',
      'start\nrule Decide [decision: Approve loan]\nend\n',
    );
    const locations = (await client.sendRequest('textDocument/definition', {
      textDocument: { uri: uri('q.bpmnt') },
      position: { line: 1, character: 25 },
    })) as { uri: string; range: { start: { line: number } } }[];
    // The open b.dmnt beside it declares the decision too.
    expect(locations).toHaveLength(2);
    expect(locations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uri: uri('loans.dmnt'),
          range: expect.objectContaining({
            start: { line: 2, character: 9 },
          }),
        }),
      ]),
    );
  });

  it('completes, hovers and formats DMN', async () => {
    await open(uri('loans2.dmnt'), 'dmnt', loans);
    const items = (await client.sendRequest('textDocument/completion', {
      textDocument: { uri: uri('loans2.dmnt') },
      position: { line: 2, character: 33 },
    })) as { label: string }[];
    expect(items.map((i) => i.label)).toContain('Credit score');
    const hover = (await client.sendRequest('textDocument/hover', {
      textDocument: { uri: uri('loans2.dmnt') },
      position: { line: 2, character: 12 },
    })) as { contents: { value: string } };
    expect(hover.contents.value).toContain('**Decision** Approve loan');
    const edits = (await client.sendRequest('textDocument/formatting', {
      textDocument: { uri: uri('loans2.dmnt') },
      options: { tabSize: 2, insertSpaces: true },
    })) as unknown[];
    expect(edits).toEqual([]);
  });
});
