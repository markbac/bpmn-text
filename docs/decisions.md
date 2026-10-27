# Architecture decision records

Short records of the significant decisions. Status is one of *Accepted*,
*Proposed* (awaiting a spike) or *Superseded*.

---

## ADR-001: TypeScript monorepo — *Accepted*

**Context.** The deliverables are a library, a CLI, a web editor and a VS
Code extension. The key libraries (elkjs, bpmn-moddle, bpmn-js) are all
JavaScript.

**Decision.** TypeScript with ES modules, in an npm-workspaces monorepo. The
core packages are browser-safe.

**Consequences.** One language and one toolchain. The browser editor and the
VS Code preview reuse the compiler unchanged.

---

## ADR-002: Lane assignment by lane switches — *Accepted*

**Context.** Two styles were considered: *lane blocks*, where each lane is a
container and cross-lane flows are explicit arrows, and *lane switches*,
where you write story order and `lane X` changes the current lane.

**Decision.** Lane switches. A switch inside a branch is scoped to that
branch.

**Consequences.** Processes read top to bottom as they happen, need few
arrows, and work naturally with automatic joins. Seeing everything one lane
does means scanning the file. The editor's document outline (symbols grouped
by lane) makes up for this.

---

## ADR-003: Automatic join gateways — *Accepted*

**Decision.** Open branches of a split merge into the next statement after
the gateway block. A join of the matching type is inserted when there are two
or more open branches. XOR joins can be direct merges via `option xor-join
direct`.

**Consequences.** Well-structured processes need no join syntax. Merges that
are not well structured use an explicit gateway with `@id` and jumps.

---

## ADR-004: Layout = ELK layering + custom lane banding and routing — *Proposed*

**Context.** `bpmn-auto-layout` does not lay out lanes or pools. ELK's
layered algorithm produces excellent left-to-right flow layouts, but its
compound-node support places children as boxes, not as full-width bands that
the flow crosses. ELK's partitioning constrains *layers* (columns), not rows.

**Options.**

* **A.** Use ELK for global layering and node ordering across all pools.
  Custom code assigns lane bands and rows, and routes edges orthogonally.
* **B.** ELK compound graph with lanes as child nodes (`INCLUDE_CHILDREN`).
  Rejected in principle: lanes become free-floating boxes, not stacked bands.
* **C.** A fully custom Sugiyama implementation, with no ELK. More code, but
  full control. Kept as the fallback if ELK's model-order behaviour proves
  unreliable.

**Decision (proposed).** A. The issue *"Spike: lane-aware layout"* confirms
this on the example corpus (story-order preservation, loop handling,
cross-pool alignment) and moves this ADR to *Accepted* or switches to C.

---

## ADR-005: SVG/PNG rendering through bpmn-js in headless Chromium — *Accepted*

**Context.** Rendering BPMN needs text measurement and the standard BPMN
look. A custom SVG renderer would look different from the editors. bpmn-js
does not run properly under jsdom because it lacks `getBBox`.

**Decision.** `@bpmn-text/render` drives bpmn-js inside headless Chromium
through `playwright-core`, as an optional dependency of the CLI.

**Consequences.** The output looks exactly like the editors. The cost is a
heavy optional dependency, and the CLI's `.bpmn` output works without it.

---

## ADR-006: Hand-written recursive-descent parser — *Accepted*

**Context.** The language depends on indentation, has context-sensitive bare
names, and needs clear error messages with recovery.

**Decision.** A hand-written lexer (with an indentation stack) and a
recursive-descent parser, with recovery per line.

**Consequences.** Full control over diagnostics. The grammar in
`notation.md` is documentation, not generated code, so tests must keep the
two aligned.

---

## ADR-007: CodeMirror 6 for the web editor — *Accepted*

**Decision.** CodeMirror 6 rather than Monaco.

**Consequences.** A much smaller bundle and good mobile support. It lacks
Monaco's built-in LSP client, which is acceptable because the web editor
calls the core directly.

---

## ADR-008: Execution semantics out of scope for v1 — *Accepted*

**Decision.** v1 produces *descriptive* BPMN. Engine-specific attributes are
not part of the notation. Unknown attributes are kept in the IR and exposed
through a generator extension hook.

**Consequences.** Executable Camunda/Zeebe support can be added later as an
extension without changing the grammar.
