import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  check,
  type Diagnostic as BtDiagnostic,
  type KnownDecision,
} from '@bpmn-text/core';
import { checkDmn } from '@bpmn-text/dmn';
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
import {
  decisionAt,
  decisionDeclaration,
  decisionNames,
  dmnComplete,
  dmnDefinition,
  dmnFormatted,
  dmnHover,
  dmnReferences,
  dmnRename,
  dmnSymbols,
  type DmnSymbol,
} from './dmn-analysis.js';

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

const dmnSymbolKinds = {
  decision: SymbolKind.Function,
  input: SymbolKind.Variable,
  knowledge: SymbolKind.Module,
  source: SymbolKind.File,
  logic: SymbolKind.Struct,
} as const;

/** Whether a document is `.dmnt`, by language or by name. */
const isDmn = (doc: { languageId: string; uri: string }) =>
  doc.languageId === 'dmnt' || /\.dmnt$/i.test(doc.uri);

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

  /** The path of a file: URI, or undefined for other schemes. */
  const pathOf = (uri: string) => {
    try {
      return uri.startsWith('file:') ? fileURLToPath(uri) : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * The .dmnt files beside a .bpmnt document, as URI and text: the open
   * ones as edited, the rest from disk (dmn-notation §7).
   */
  const dmnFilesBeside = (doc: TextDocument) => {
    const files = new Map<string, string>();
    const path = pathOf(doc.uri);
    if (path) {
      try {
        for (const f of readdirSync(dirname(path))) {
          if (!/\.dmnt$/i.test(f)) continue;
          const file = join(dirname(path), f);
          files.set(pathToFileURL(file).href, readFileSync(file, 'utf8'));
        }
      } catch {
        // An unreadable folder: only the open documents count.
      }
    }
    for (const d of documents.all()) {
      if (!isDmn(d)) continue;
      const other = pathOf(d.uri);
      if (path && other && dirname(other) !== dirname(path)) continue;
      files.set(d.uri, d.getText());
    }
    return files;
  };

  const knownDecisions = (doc: TextDocument): KnownDecision[] | undefined => {
    const files = dmnFilesBeside(doc);
    if (files.size === 0) return undefined;
    return [...files].flatMap(([uri, text]) =>
      decisionNames(text).map((name) => ({ name, file: pathOf(uri) ?? uri })),
    );
  };

  const validate = (doc: TextDocument) => {
    const decisions = isDmn(doc) ? undefined : knownDecisions(doc);
    const found = isDmn(doc)
      ? checkDmn(doc.getText()).diagnostics
      : check(doc.getText(), decisions ? { decisions } : {}).diagnostics;
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
      completionProvider: {
        triggerCharacters: ['>', ' ', '[', ',', ':', '|'],
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
    },
  }));

  documents.onDidChangeContent((e) => {
    validate(e.document);
    // Decisions changed: the rule tasks that name them may have too.
    if (isDmn(e.document))
      for (const d of documents.all()) if (!isDmn(d)) validate(d);
  });
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
    const result = isDmn(doc)
      ? dmnComplete(doc.getText(), offset)
      : complete(doc.getText(), offset);
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
    const found =
      doc &&
      (isDmn(doc) ? dmnHover : hover)(
        doc.getText(),
        doc.offsetAt(params.position),
      );
    if (!doc || !found) return null;
    return {
      contents: { kind: 'markdown', value: found.markdown },
      range: range(doc, found.range),
    };
  });

  connection.onDefinition((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const offset = doc.offsetAt(params.position);
    if (isDmn(doc))
      return dmnDefinition(doc.getText(), offset).map((s) => ({
        uri: doc.uri,
        range: range(doc, s),
      }));
    // From a rule task's `[decision: …]` to the decision (#80).
    const link = decisionAt(doc.getText(), offset);
    if (link) {
      const found = [];
      for (const [uri, text] of dmnFilesBeside(doc)) {
        if (
          link.file &&
          !uri.toLowerCase().endsWith(`/${link.file.toLowerCase()}`)
        )
          continue;
        const at = decisionDeclaration(text, link.name);
        if (!at) continue;
        const target = TextDocument.create(uri, 'dmnt', 0, text);
        found.push({ uri, range: range(target, at) });
      }
      return found;
    }
    return definition(doc.getText(), offset).map((s) => ({
      uri: doc.uri,
      range: range(doc, s),
    }));
  });

  connection.onReferences((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    return (isDmn(doc) ? dmnReferences : references)(
      doc.getText(),
      doc.offsetAt(params.position),
    ).map((s) => ({ uri: doc.uri, range: range(doc, s) }));
  });

  connection.onPrepareRename((params) => {
    const doc = documents.get(params.textDocument.uri);
    const found =
      doc &&
      (isDmn(doc) ? dmnRename : rename)(
        doc.getText(),
        doc.offsetAt(params.position),
        '',
      );
    if (!doc || !found) return null;
    return { range: range(doc, found.range), placeholder: found.placeholder };
  });

  connection.onRenameRequest((params) => {
    const doc = documents.get(params.textDocument.uri);
    const found =
      doc &&
      (isDmn(doc) ? dmnRename : rename)(
        doc.getText(),
        doc.offsetAt(params.position),
        params.newName,
      );
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
    if (isDmn(doc)) {
      const convertDmn = (s: DmnSymbol): DocumentSymbol =>
        DocumentSymbol.create(
          s.name,
          s.detail,
          dmnSymbolKinds[s.kind],
          range(doc, s.range),
          range(doc, s.selection),
          s.children.map(convertDmn),
        );
      return dmnSymbols(doc.getText()).map(convertDmn);
    }
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
    const text = doc && (isDmn(doc) ? dmnFormatted : formatted)(doc.getText());
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
