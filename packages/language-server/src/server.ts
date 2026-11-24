import { check, type Diagnostic as BtDiagnostic } from '@bpmn-text/core';
import {
  CodeActionKind,
  CompletionItemKind,
  createConnection,
  DiagnosticSeverity,
  DocumentSymbol,
  ErrorCodes,
  ProposedFeatures,
  ResponseError,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
  TextEdit,
  type CodeAction,
  type Connection,
  type Diagnostic,
  type InitializeResult,
  type Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  complete,
  definition,
  formatted,
  hover,
  references,
  rename,
  symbols,
  type DocumentSymbol as Symbol,
  type Span,
} from './analysis.js';

const severities = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
} as const;

const symbolKinds = {
  pool: SymbolKind.Namespace,
  lane: SymbolKind.Package,
  element: SymbolKind.Function,
  subprocess: SymbolKind.Module,
  group: SymbolKind.Class,
  data: SymbolKind.Variable,
} as const;

const completionKinds = {
  keyword: CompletionItemKind.Keyword,
  type: CompletionItemKind.EnumMember,
  property: CompletionItemKind.Property,
  variable: CompletionItemKind.Variable,
  namespace: CompletionItemKind.Module,
} as const;

/** Starts the language server on `connection`, over IPC by default. */
export function startServer(
  connection: Connection = createConnection(ProposedFeatures.all),
): void {
  const documents = new TextDocuments(TextDocument);
  const diagnosticsOf = new Map<string, BtDiagnostic[]>();

  const range = (doc: TextDocument, s: Span): Range => ({
    start: doc.positionAt(s.start),
    end: doc.positionAt(s.end),
  });

  const validate = (doc: TextDocument) => {
    const found = check(doc.getText()).diagnostics;
    diagnosticsOf.set(doc.uri, found);
    const out: Diagnostic[] = found.map((d) => {
      // An empty range covers one character, so that it shows.
      const start = d.range.start.offset;
      const end = Math.max(d.range.end.offset, start + 1);
      return {
        range: range(doc, { start, end }),
        severity: severities[d.severity],
        code: d.code,
        source: 'bpmn-text',
        message: d.message,
        ...(d.related && {
          relatedInformation: d.related.map((r) => ({
            location: {
              uri: doc.uri,
              range: range(doc, {
                start: r.range.start.offset,
                end: r.range.end.offset,
              }),
            },
            message: r.message,
          })),
        }),
      };
    });
    void connection.sendDiagnostics({ uri: doc.uri, diagnostics: out });
  };

  connection.onInitialize((): InitializeResult => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ['>', ' ', '[', ','] },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
    },
  }));

  documents.onDidChangeContent((e) => validate(e.document));
  documents.onDidClose((e) => {
    diagnosticsOf.delete(e.document.uri);
    void connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  });

  connection.onCompletion((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const offset = doc.offsetAt(params.position);
    // A space starts completion after `->`, `lane` or an event keyword,
    // not in the indentation at the start of a line.
    if (params.context?.triggerCharacter === ' ') {
      const line = doc.getText({
        start: { line: params.position.line, character: 0 },
        end: params.position,
      });
      if (!line.trim()) return [];
    }
    const result = complete(doc.getText(), offset);
    if (!result) return [];
    const replace = range(doc, { start: result.from, end: offset });
    return result.options.map((o) => ({
      label: o.label,
      kind: completionKinds[o.type],
      textEdit: TextEdit.replace(replace, o.apply ?? o.label),
    }));
  });

  connection.onHover((params) => {
    const doc = documents.get(params.textDocument.uri);
    const found = doc && hover(doc.getText(), doc.offsetAt(params.position));
    if (!doc || !found) return null;
    return {
      contents: { kind: 'markdown', value: found.markdown },
      range: range(doc, found.range),
    };
  });

  connection.onDefinition((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    return definition(doc.getText(), doc.offsetAt(params.position)).map(
      (s) => ({ uri: doc.uri, range: range(doc, s) }),
    );
  });

  connection.onReferences((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    return references(doc.getText(), doc.offsetAt(params.position)).map(
      (s) => ({ uri: doc.uri, range: range(doc, s) }),
    );
  });

  connection.onPrepareRename((params) => {
    const doc = documents.get(params.textDocument.uri);
    const found =
      doc && rename(doc.getText(), doc.offsetAt(params.position), '');
    if (!doc || !found) return null;
    return { range: range(doc, found.range), placeholder: found.placeholder };
  });

  connection.onRenameRequest((params) => {
    const doc = documents.get(params.textDocument.uri);
    const found =
      doc &&
      rename(doc.getText(), doc.offsetAt(params.position), params.newName);
    if (!doc || !found) return null;
    if (found.error)
      throw new ResponseError(ErrorCodes.InvalidParams, found.error);
    return {
      changes: {
        [doc.uri]: found.edits.map((e) =>
          TextEdit.replace(range(doc, e.range), e.newText),
        ),
      },
    };
  });

  connection.onDocumentSymbol((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const convert = (s: Symbol): DocumentSymbol =>
      DocumentSymbol.create(
        s.name,
        s.detail,
        symbolKinds[s.kind],
        range(doc, s.range),
        range(doc, s.selection),
        s.children.map(convert),
      );
    return symbols(doc.getText()).map(convert);
  });

  connection.onDocumentFormatting((params) => {
    const doc = documents.get(params.textDocument.uri);
    const text = doc && formatted(doc.getText());
    if (!doc || text === undefined) return [];
    const whole = range(doc, { start: 0, end: doc.getText().length });
    return [TextEdit.replace(whole, text)];
  });

  connection.onCodeAction((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const actions: CodeAction[] = [];
    for (const d of diagnosticsOf.get(doc.uri) ?? []) {
      const start = d.range.start.offset;
      const end = Math.max(d.range.end.offset, start + 1);
      const shown = range(doc, { start, end });
      const overlaps =
        params.range.start.line <= shown.end.line &&
        params.range.end.line >= shown.start.line;
      if (!overlaps) continue;
      for (const fix of d.fixes ?? []) {
        actions.push({
          title: fix.title,
          kind: CodeActionKind.QuickFix,
          edit: {
            changes: {
              [doc.uri]: fix.edits.map((e) =>
                TextEdit.replace(
                  range(doc, {
                    start: e.range.start.offset,
                    end: e.range.end.offset,
                  }),
                  e.newText,
                ),
              ),
            },
          },
        });
      }
    }
    return actions;
  });

  documents.listen(connection);
  connection.listen();
}
