# Functionality

## 1. Purpose

Writing BPMN 2.0 XML by hand is impractical: the semantic model is verbose,
and the diagram interchange (DI) section needs explicit coordinates for every
shape and edge. Drawing in a modeller works, but the result is hard to
review, diff, generate or keep in version control.

**bpmn-text** lets people write process diagrams as plain text, in a compact,
human-friendly notation (see [notation.md](notation.md)). It compiles that
text into **standard BPMN 2.0 XML with a complete, automatically computed
layout**, ready to open in Camunda Modeler, bpmn.io, Signavio and other
BPMN tools.

## 2. Users and use cases

| User | Use case |
|---|---|
| Business analyst | Sketch a process quickly while talking to stakeholders, without fighting a drawing tool. |
| Developer | Keep process documentation next to code, reviewed in pull requests, regenerated in CI. |
| Architect / technical writer | Produce consistent, well-laid-out diagrams for documentation sites. |
| Tool builders / LLM workflows | Generate BPMN from a format that is easy for programs and language models to emit. |

## 3. Scope

### 3.1 In scope (v1)

* **Notation:** core BPMN plus common extras:
  * start, end, intermediate catch and throw events (none, message, timer,
    signal, error, escalation, conditional, compensation, terminate, link);
  * tasks (abstract, user, service, script, send, receive, manual, business
    rule), call activities;
  * exclusive, parallel, inclusive and event-based gateways;
  * sequence flows (implicit and explicit, labelled, default flows);
  * pools (expanded and collapsed), lanes (lane switches) and message flows;
  * embedded subprocesses (expanded and collapsed);
  * boundary events (interrupting and non-interrupting);
  * data objects, data stores, data associations;
  * text annotations;
  * loop and multi-instance markers.
* **Deliverables**
  1. **Core library** (`@bpmn-text/core` and friends): parse, validate,
     lay out and generate BPMN XML. Usable from Node and the browser.
  2. **CLI** (`bpmn-text`): build `.bpmn`, `.svg` and `.png` files, check
     files, format files, watch mode.
  3. **Live web editor:** text on the left, rendered diagram on the right,
     updated as you type, with export.
  4. **VS Code extension:** syntax highlighting, diagnostics, completion,
     navigation and live preview.

### 3.2 Out of scope (v1)

* Execution semantics: engine-specific attributes (Camunda/Zeebe task
  types, forms, condition expressions, I/O mappings). The architecture leaves
  room for this as an extension (see [architecture.md §9](architecture.md)).
* Reverse conversion (`.bpmn` → text).
* Nested lanes (child lane sets), event subprocesses, transactions, groups,
  conversations, choreographies.
* Manual layout hints or pinned coordinates.
* Round-tripping manual edits made in a modeller back into the text.

## 4. Functional requirements

### 4.1 Language and compilation

| ID | Requirement |
|---|---|
| FR-1 | Parse `.bpmnt` files according to [notation.md](notation.md). |
| FR-2 | Infer sequence flows from story order (implicit flow), chains and jumps. |
| FR-3 | Insert join gateways automatically for open gateway branches (AND→AND, OR→OR, XOR/event→XOR, with an option for direct XOR merges). |
| FR-4 | Assign elements to lanes by lane switches, with branch scoping and `[lane: X]` overrides. |
| FR-5 | Resolve references by `@id` or name (case-insensitive, whitespace-normalised) and report ambiguity. |
| FR-6 | Report **all** syntax and semantic problems in one run, with stable codes, line/column ranges and, where possible, suggestions ("did you mean …?") and quick fixes. |
| FR-7 | Validate model rules (cross-pool flows, unreachable nodes, dead ends, invalid boundary/gateway configurations; see notation §11). |
| FR-8 | Generate deterministic element IDs derived from names, so the same input always produces byte-identical output. |

### 4.2 Output

| ID | Requirement |
|---|---|
| FR-10 | Emit BPMN 2.0 XML that validates against the OMG BPMN 2.0 XSD. |
| FR-11 | Emit complete BPMN DI: shapes, edges with waypoints, label bounds, horizontal pools and lanes, separate planes for collapsed subprocesses. |
| FR-12 | Output opens without warnings in bpmn-js (and therefore Camunda Modeler). |
| FR-13 | Export SVG and PNG renderings of the diagram. |

### 4.3 Layout

| ID | Requirement |
|---|---|
| FR-20 | Lay out flow left to right, with standard BPMN element sizes. |
| FR-21 | Stack pools vertically in document order, all the same width. |
| FR-22 | Draw lanes as full-width horizontal bands inside their pool, in declared or first-appearance order, each sized to fit its content. |
| FR-23 | Keep elements inside their lane band, even when flow moves between lanes. |
| FR-24 | Route sequence flows orthogonally, avoiding overlaps with shapes, including loops (back edges) and cross-lane flows. |
| FR-25 | Align columns (layers) across pools so message flows are as short and vertical as possible. |
| FR-26 | Place boundary events on the host's border, data objects near their activity, and annotations near their element. |
| FR-27 | Lay out expanded subprocesses recursively and size them to their content. |
| FR-28 | Lay out a 200-node collaboration in under 1 second on a typical laptop. |

### 4.4 CLI

| ID | Requirement |
|---|---|
| FR-30 | `bpmn-text build <files…>` writes `.bpmn` (default), `.svg` or `.png`, to an `-o` path/directory or to stdout. |
| FR-31 | `bpmn-text check <files…>` validates only. Exit code 1 on errors. `--format json` gives machine-readable diagnostics. |
| FR-32 | `bpmn-text fmt <files…>` rewrites files in canonical style. `--check` verifies formatting without writing. |
| FR-33 | `--watch` rebuilds on change. |
| FR-34 | Accept stdin and globs. Diagnostics are printed with code frames and colours (disabled when not a TTY). |

### 4.5 Web editor

| ID | Requirement |
|---|---|
| FR-40 | Split view: code editor on the left, diagram (bpmn-js viewer) on the right, both resizable. |
| FR-41 | Recompile as you type (debounced). Errors show inline, and the last valid diagram stays visible. |
| FR-42 | Syntax highlighting, completion of keywords and element names. |
| FR-43 | Clicking a diagram element highlights its source line, and moving the cursor highlights the element. |
| FR-44 | Export `.bpmnt`, `.bpmn`, `.svg` and `.png`. Load the bundled examples. Save the current document locally, and share via a URL that holds the compressed source. |
| FR-45 | Runs fully client-side as a static site, with no server. |

### 4.6 VS Code extension

| ID | Requirement |
|---|---|
| FR-50 | Language registration for `.bpmnt`, with syntax highlighting (TextMate grammar), bracket and comment configuration. |
| FR-51 | Language server: diagnostics, completion, hover (element type and lane), go to definition and find references for names and IDs, document symbols (pools/lanes/elements), rename, formatting. |
| FR-52 | A live preview panel beside the editor, synced with the cursor. |
| FR-53 | Commands: *Export BPMN*, *Export SVG/PNG*. Build on save is optional. |

## 5. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | TypeScript, ES modules. Runs on Node 20+ and in evergreen browsers. |
| NFR-2 | The core packages have no Node-only dependencies, so they can be bundled for browsers. |
| NFR-3 | Deterministic: identical input and options give identical output. |
| NFR-4 | Compile time for 200 elements is under 1 s. Incremental editor updates take under 200 ms for typical diagrams (≤ 60 elements). |
| NFR-5 | ≥ 90% line coverage on the parser and model builder. Every notation feature has a golden example test. |
| NFR-6 | Diagnostics are clear to non-programmers and never expose stack traces in normal use. |
| NFR-7 | The documentation (notation reference, tutorial, cookbook) is kept in sync with the implementation. Examples in the docs are compiled in CI. |

## 6. Success criteria

* All six files in `examples/` compile without errors and open cleanly in
  Camunda Modeler. A reviewer judges the layouts "would not need manual
  tidying" for at least 5 of the 6.
* A first-time user can write the order-fulfilment example from the notation
  reference in under 15 minutes.
