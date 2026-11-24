# bpmn-text for VS Code

Write BPMN as text in `.bpmnt` files and see the diagram beside it.

## Features

- Syntax highlighting, comment and bracket handling.
- Diagnostics as you type, with quick fixes where the compiler has one.
- Completion of keywords, event types, attributes, lane names and element names.
- Hover (element type, lane and documentation), go to definition, find references, rename and document outline.
- Format document.
- **Open Preview to the Side** (the button in the editor title bar) draws the diagram live.
  Clicking a shape selects its source, and moving the cursor highlights its shape.
  While the text has errors, the last good diagram stays on screen.
- **Export BPMN**, **Export SVG** and **Export PNG** from the Command Palette.
- Optional `bpmnText.buildOnSave` writes a `.bpmn` file next to the source on each error-free save.

See the [notation reference](https://github.com/markbac/bpmn-text/blob/main/docs/notation.md).
