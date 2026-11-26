---
'bpmn-text': minor
'@bpmn-text/dmn': minor
'@bpmn-text/core': minor
'@bpmn-text/render': minor
'@bpmn-text/language-server': minor
'bpmn-text-vscode': minor
---

Add DMN: decision requirements diagrams, decision tables and literal
expressions written as `.dmnt` text and compiled to DMN 1.3 XML with DMNDI
(`compileDmn()`, `checkDmn()`, and `build`, `check` and `fmt` by file
extension). Tables are checked for overlapping rules, gaps and rules that can
never be chosen, and FEEL in cells is checked at the cell. The renderer draws
DRDs as SVG and PNG and tables as PNG. A BPMN business rule task names the
decision it evaluates with `[decision: …]`, checked against the `.dmnt` files
beside it. The web editor, the language server and the VS Code extension
handle `.dmnt` with highlighting, completion, diagnostics, a live dmn-js
preview and formatting with aligned tables. The VS Code extension has an icon.
