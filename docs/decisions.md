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

## ADR-004: Layout = ELK layering + custom lane banding and routing — *Accepted*

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

**Decision.** A, confirmed by the spike in issue #3 on examples 02, 03 and
04 ([report](spikes/lane-layout/README.md)). With ELK model order and
model-order cycle breaking, no forward flow was drawn backwards, the one
loop became a back edge, columns lined up across pools, there were no
overlaps or edges through shapes, and the result was deterministic. Option
C is not needed.

**Consequences.** ELK must be given a single *story order* across pools, in
which a message flow's target follows its source. Otherwise model-order
cycle breaking reverses message flows from a later pool to an earlier one.
Routing chooses each edge's shape by checking for obstacles, and widens
column channels from a first pass that counts tracks (architecture §6.2,
phases 2, 5 and 6).

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

---

## ADR-009: Groups are transparent blocks laid out as column partitions — *Accepted*

**Context.** Real process documents use BPMN groups to mark **phases**, such
as *Fulfilment* and *After-sales*. Each phase is a dashed box
spanning all lanes. A group is purely visual in BPMN, but if layout ignores
it, elements from different phases end up inside each other's boxes.

**Decision.** `group X` is a block that does **not** affect flow or lane
scoping. It only tags its members. Layout uses ELK partitioning so that each
group's members take up consecutive columns that no other element shares.
By default the box spans the full pool height, and `[fit]` makes it hug its
members. Nested and overlapping groups are out of scope for v1.

**Consequences.** Phase diagrams lay out correctly with no manual hints.
Groups that are not contiguous in story order are not supported; the
workaround is a `[fit]` group per contiguous run.

---

## ADR-010: Gateway-less fan-out (`fork`, multi-target jumps) — *Accepted*

**Context.** Many existing diagrams split flow by giving a task several
outgoing flows, with no parallel gateway. A transcription must be able to
reproduce that exactly.

**Decision.** Multi-target jumps (`-> A, B`) and a `fork` block, which has
branch syntax but draws no gateway. Open `fork` branches still join through
an inserted *parallel* gateway to stay semantically correct. Authors who want
no join end each branch with a jump.

**Consequences.** Diagrams can be transcribed exactly without losing the
story-order style. Uncontrolled merges need no extra syntax.

---

## ADR-011: Colours emitted in both colour namespaces — *Accepted*

**Decision.** `[color:]` and `[stroke:]` are written as both OMG *BPMN in
Color* (`color:background-color`, `color:border-color`) and bpmn-js
`bioc:fill` / `bioc:stroke` attributes.

**Consequences.** Colours show in bpmn.io, Camunda Modeler and other tools
that support the OMG extension. Lane colours fill the whole lane, since DI
cannot colour only the lane header.
