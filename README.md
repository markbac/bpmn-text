# bpmn-text

**Write BPMN diagrams as text and get laid-out BPMN 2.0 XML.**

bpmn-text compiles a compact, human-writable notation into standard BPMN 2.0
XML, **with automatic layout of pools, lanes and flows**. The result opens
in Camunda Modeler, bpmn.io, Signavio and other BPMN tools.

```
pool Customer
  start Need product
  send Place order ~> Receive order
  receive Confirmation
  end Done

pool Company
  lane Sales
  receive Receive order
  task Check credit
  xor Credit OK?
    yes:
      lane Warehouse
      task Pick items
    no:
      task Request prepayment
      receive Payment received
  lane Warehouse
  task Ship parcel
  send Send confirmation ~> Confirmation
  end Shipped
```

You write the process in the order it happens. Sequence flows, join
gateways, lane placement and the whole diagram layout are inferred.

> **Status: design phase.** No code yet. The specification and plan are
> below, and work is tracked in [issues](../../issues) and
> [milestones](../../milestones).

## Planned deliverables

| Deliverable | Description |
|---|---|
| **Compiler library** | `parse` / `check` / `compile` / `format`. Runs in Node and the browser. |
| **CLI** | `bpmn-text build \| check \| fmt`, outputs `.bpmn`, `.svg` and `.png`, with watch mode. |
| **Web editor** | Text on the left, live diagram on the right, fully client-side. |
| **VS Code extension** | Highlighting, diagnostics, completion, navigation and live preview. |

## Documentation

| Document | Contents |
|---|---|
| [Functionality](docs/functionality.md) | Purpose, scope, functional and non-functional requirements |
| [Notation reference](docs/notation.md) | The `.bpmnt` language: elements, flows, gateways, lanes, diagnostics, grammar |
| [Architecture](docs/architecture.md) | C4 views, pipeline, packages, layout engine, BPMN generation, testing |
| [Decisions](docs/decisions.md) | Architecture decision records (ADRs) |
| [Development plan](docs/development-plan.md) | Milestones, critical path, issue breakdown |
| [Examples](examples/) | Example `.bpmnt` files covering every feature |

## Key design choices

* **Story order with lane switches.** `lane X` changes the lane for the
  steps that follow, and the flow continues across lanes automatically.
* **Automatic joins.** Open gateway branches merge into the next step
  through an inserted join gateway of the matching type.
* **Deterministic output.** Stable, readable IDs, so generated `.bpmn` files
  diff cleanly.
* **Lane-aware layout.** ELK layered layout for flow ordering, combined with
  custom lane banding and orthogonal routing. This is validated by a spike
  first (ADR-004).
* **Groups, colours, documentation, gateway-less fan-out**, so real-world
  diagrams can be transcribed faithfully (ADR-009–011).
* **Descriptive BPMN first.** Execution attributes (Camunda/Zeebe) are out of
  scope for v1, and an extension hook leaves room for them later.

## Tech stack

TypeScript monorepo (npm workspaces) · elkjs · bpmn-moddle · bpmn-js ·
CodeMirror 6 · vscode-languageserver · Vitest · Playwright

## Development

Requires Node 20 or later.

```bash
npm install
npm run build      # tsup build of every workspace (ESM + .d.ts)
npm test           # Vitest across all workspaces
npm run typecheck  # tsc -b over the project references
npm run lint       # ESLint (including dependency direction) and Prettier
```

Workspaces import each other through the `source` export condition, so
type checking and tests run against TypeScript sources without a prior
build. The allowed dependencies between workspaces (architecture §2) are
defined in `eslint.config.js` and enforced by `npm run lint`.

> **Note:** npm 10 crashes (`Cannot read properties of null (reading
> 'edgesOut')`) when it has to resolve Vitest 4 without a lockfile.
> Installing from the committed `package-lock.json` works with npm 10, but
> regenerate the lockfile or add dependencies with npm 11
> (`npx npm@11 install ...`).
