import {
  diagnostic,
  type Diagnostic,
  type DiagnosticCode,
  type Range,
} from './diagnostics.js';
import type { Container, FlowNode, Model } from './model.js';

/** A model check: one code, independent of the others (architecture §5). */
export interface Rule {
  code: DiagnosticCode;
  check(model: Model): Diagnostic[];
}

export interface ValidateOptions {
  /** Turn rules off by code, such as `{ BT304: false }`. */
  rules?: Partial<Record<DiagnosticCode, boolean>>;
}

/** Runs every enabled rule over the model. */
export function validate(
  model: Model,
  options: ValidateOptions = {},
): Diagnostic[] {
  return rules
    .filter((r) => options.rules?.[r.code] !== false)
    .flatMap((r) => r.check(model));
}

/** Every flow node, including those inside subprocesses, with its container. */
function* allNodes(c: Container): Generator<[FlowNode, Container]> {
  for (const n of c.nodes) {
    yield [n, c];
    if (n.children) yield* allNodes(n.children);
  }
}
function* modelNodes(model: Model): Generator<[FlowNode, Container]> {
  for (const p of model.pools) if (p.process) yield* allNodes(p.process);
}
/** The keyword at the start of an element. */
const keyword = (n: FlowNode): Range => ({
  start: n.source.start,
  end: n.source.start,
});
const isLinkThrow = (n: FlowNode) =>
  n.kind === 'intermediateThrowEvent' && n.eventType === 'link';
const isLinkCatch = (n: FlowNode) =>
  n.kind === 'intermediateCatchEvent' && n.eventType === 'link';
const normalise = (name: string) =>
  name.trim().replace(/\s+/g, ' ').toLowerCase();

const counts = new WeakMap<Container, ReturnType<typeof countFlows>>();
function flowCounts(c: Container) {
  if (!counts.has(c)) counts.set(c, countFlows(c));
  return counts.get(c)!;
}
function countFlows(c: Container) {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const f of c.flows) {
    outgoing.set(f.sourceRef, (outgoing.get(f.sourceRef) ?? 0) + 1);
    incoming.set(f.targetRef, (incoming.get(f.targetRef) ?? 0) + 1);
  }
  return { incoming, outgoing };
}

/** Whether a catcher (unnamed: any) handles what `thrower` throws. */
const catches = (catcher: FlowNode, thrower: FlowNode) =>
  catcher.eventType === thrower.eventType &&
  (!catcher.definitionRef ||
    !thrower.definitionRef ||
    catcher.definitionRef === thrower.definitionRef);
/** Error end events, and escalation end and throw events. */
const throwsUp = (n: FlowNode) =>
  (n.eventType === 'error' && n.kind === 'endEvent') ||
  (n.eventType === 'escalation' &&
    (n.kind === 'endEvent' || n.kind === 'intermediateThrowEvent'));

export const rules: Rule[] = [
  {
    code: 'BT222',
    check(model) {
      const out: Diagnostic[] = [];
      for (const [n] of modelNodes(model)) {
        if (n.branches === 1) {
          out.push(
            diagnostic(
              'BT222',
              'This gateway has a single branch, so it decides nothing. Remove it or add a branch.',
              keyword(n),
            ),
          );
        }
      }
      return out;
    },
  },
  {
    code: 'BT240',
    check(model) {
      const out: Diagnostic[] = [];
      for (const [n] of modelNodes(model)) {
        if (
          n.kind === 'boundaryEvent' &&
          n.interrupting === false &&
          (n.eventType === 'error' || n.eventType === 'compensation')
        ) {
          out.push(
            diagnostic(
              'BT240',
              `A boundary ${n.eventType} event always interrupts the activity; remove \`non-interrupting\`.`,
              n.attributeRanges['non-interrupting'] ?? keyword(n),
            ),
          );
        }
      }
      return out;
    },
  },
  {
    code: 'BT260',
    check(model) {
      const out: Diagnostic[] = [];
      for (const [n] of modelNodes(model)) {
        if (!isLinkThrow(n) || n.linkTarget) continue;
        out.push(
          diagnostic(
            'BT260',
            n.name
              ? `No \`catch link ${n.name}\` in this process level, so flow stops here.`
              : 'A link throw event needs a name: it pairs with the `catch link` of the same name.',
            keyword(n),
          ),
        );
      }
      return out;
    },
  },
  {
    code: 'BT261',
    check(model) {
      const out: Diagnostic[] = [];
      for (const [n] of modelNodes(model)) {
        if (!isLinkCatch(n) || n.linkSources?.length) continue;
        out.push(
          diagnostic(
            'BT261',
            n.name
              ? `No \`throw link ${n.name}\` in this process level, so this can never be reached.`
              : 'A link catch event needs a name: it pairs with the `throw link` of the same name.',
            keyword(n),
          ),
        );
      }
      return out;
    },
  },
  {
    code: 'BT262',
    check(model) {
      const out: Diagnostic[] = [];
      const seen = new Map<Container, Map<string, FlowNode>>();
      for (const [n, c] of modelNodes(model)) {
        if (!isLinkCatch(n) || !n.name) continue;
        const names = seen.get(c) ?? new Map<string, FlowNode>();
        seen.set(c, names);
        const first = names.get(normalise(n.name));
        if (!first) {
          names.set(normalise(n.name), n);
          continue;
        }
        out.push(
          diagnostic(
            'BT262',
            `This process level already has a \`catch link ${n.name}\` on line ${first.source.start.line}: a throw event must lead to one place.`,
            keyword(n),
            { related: [{ message: 'First catch', range: first.source }] },
          ),
        );
      }
      return out;
    },
  },
  {
    code: 'BT301',
    check(model) {
      const messageTargets = new Set(
        model.messageFlows.map((f) => f.targetRef),
      );
      const out: Diagnostic[] = [];
      for (const [n, c] of modelNodes(model)) {
        if (
          n.kind === 'startEvent' ||
          n.kind === 'boundaryEvent' ||
          isLinkCatch(n)
        )
          continue;
        if (flowCounts(c).incoming.has(n.id) || messageTargets.has(n.id))
          continue;
        out.push(
          diagnostic(
            'BT301',
            'Nothing flows into this element, so it can never be reached.',
            keyword(n),
          ),
        );
      }
      return out;
    },
  },
  {
    code: 'BT302',
    check(model) {
      const out: Diagnostic[] = [];
      for (const [n, c] of modelNodes(model)) {
        if (n.kind === 'endEvent' || n.endsOpenBoundaryChain || isLinkThrow(n))
          continue;
        if (flowCounts(c).outgoing.has(n.id)) continue;
        out.push(
          diagnostic(
            'BT302',
            'Nothing flows out of this element. End the chain with `end`, or jump somewhere with `->`.',
            keyword(n),
          ),
        );
      }
      return out;
    },
  },
  {
    code: 'BT303',
    check(model) {
      const out: Diagnostic[] = [];
      for (const pool of model.pools) {
        const nodes = pool.process?.nodes;
        if (!nodes) continue;
        const missing = [
          nodes.some((n) => n.kind === 'startEvent') ? undefined : 'start',
          nodes.some((n) => n.kind === 'endEvent') ? undefined : 'end',
        ].filter(Boolean);
        if (!missing.length) continue;
        out.push(
          diagnostic(
            'BT303',
            `${pool.implicit ? 'The process' : `Pool \`${pool.name}\``} has no ${missing.join(' or ')} event.`,
            { start: pool.source.start, end: pool.source.start },
          ),
        );
      }
      return out;
    },
  },
  {
    code: 'BT305',
    check(model) {
      const out: Diagnostic[] = [];
      for (const [n, c] of modelNodes(model)) {
        if (
          n.kind !== 'boundaryEvent' ||
          (n.eventType !== 'error' && n.eventType !== 'escalation')
        )
          continue;
        const body = c.nodes.find((h) => h.id === n.attachedTo)?.children;
        if (!body?.nodes.length) continue;
        const thrown = [...allNodes(body)].some(
          ([t]) => throwsUp(t) && catches(n, t),
        );
        if (thrown) continue;
        out.push(
          diagnostic(
            'BT305',
            `Nothing inside this subprocess throws ${n.name ? `\`${n.name}\`` : `an ${n.eventType}`}, so this boundary event never fires.`,
            keyword(n),
          ),
        );
      }
      return out;
    },
  },
  {
    code: 'BT306',
    check(model) {
      const out: Diagnostic[] = [];
      const walk = (c: Container, handlers: FlowNode[], nested: boolean) => {
        for (const n of c.nodes) {
          if (nested && throwsUp(n) && !handlers.some((h) => catches(h, n))) {
            out.push(
              diagnostic(
                'BT306',
                `Nothing around this subprocess catches ${n.name ? `\`${n.name}\`` : `this ${n.eventType}`}. Add \`on ${n.eventType}\` under the \`sub\` if it should be handled.`,
                keyword(n),
              ),
            );
          }
          if (!n.children) continue;
          const hosted = c.nodes.filter((b) => b.attachedTo === n.id);
          walk(n.children, [...handlers, ...hosted], true);
        }
      };
      for (const p of model.pools) if (p.process) walk(p.process, [], false);
      return out;
    },
  },
  {
    code: 'BT304',
    check(model) {
      const connected = new Set(
        model.messageFlows.flatMap((f) => [f.sourceRef, f.targetRef]),
      );
      const out: Diagnostic[] = [];
      for (const [n] of modelNodes(model)) {
        if (
          (n.kind === 'sendTask' || n.kind === 'receiveTask') &&
          !connected.has(n.id)
        ) {
          const what = n.kind === 'sendTask' ? 'sends' : 'receives';
          out.push(
            diagnostic(
              'BT304',
              `This task ${what} a message, but has no message flow (\`~>\`).`,
              keyword(n),
            ),
          );
        }
      }
      return out;
    },
  },
];
