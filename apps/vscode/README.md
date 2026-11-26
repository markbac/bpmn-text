# bpmn-text for VS Code

Write BPMN as text in `.bpmnt` files, and DMN decisions in `.dmnt` files, and see
the diagram beside them.

## Features

- Syntax highlighting, comment and bracket handling, for both notations; in
  `.dmnt`, table bars, `->`, `//` and the FEEL in cells and literals too.
- Diagnostics as you type, with quick fixes where the compiler has one. In DMN,
  errors in cells point at the cell, and overlapping rules, gaps and rules that
  can never be chosen are reported on the rows.
- Completion of keywords, event types, attributes, lane names and element names;
  in DMN, requirements, types, hit policies and table headings.
- Hover (element type, lane and documentation; in DMN, types, requirements and
  the table), go to definition, find references, rename and document outline.
- From a business rule task's `[decision: …]`, go to the decision in the `.dmnt`
  file beside it; a misspelt decision is reported.
- Format document, which in `.dmnt` aligns table columns.
- **Open Preview to the Side** (the button in the editor title bar) draws the diagram live.
  Clicking a shape selects its source, and moving the cursor highlights its shape.
  In a `.dmnt` file the preview shows the decision requirements diagram, or the
  table of the decision under the cursor. While the text has errors, the last
  good diagram stays on screen.
- **Export BPMN**, **Export DMN**, **Export SVG** and **Export PNG** from the Command Palette.
- Optional `bpmnText.buildOnSave` writes a `.bpmn` or `.dmn` file next to the source on each error-free save.

See the [BPMN notation](https://github.com/markbac/bpmn-text/blob/main/docs/notation.md)
and the [DMN notation](https://github.com/markbac/bpmn-text/blob/main/docs/dmn-notation.md).
