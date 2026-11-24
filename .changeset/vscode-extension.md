---
'bpmn-text-vscode': minor
'@bpmn-text/language-server': minor
'@bpmn-text/core': minor
---

Add the VS Code extension and its language server (milestone M6). The extension
adds highlighting, diagnostics with quick fixes, completion, hover, go to
definition, find references, rename, document symbols, formatting, a live preview
beside the editor that stays in step with the cursor, and Export BPMN, SVG and PNG.
Completion and `elementAt` moved into `@bpmn-text/core`, so the web editor and the
language server share them.
