import type {
  Attr,
  BoundaryStmt,
  Branch,
  Document,
  ElementDecl,
  ElementKind,
  FlowStep,
  ForkStmt,
  GatewayStmt,
  Ref,
  Statement,
  SubStmt,
} from './ast.js';
import { diagnostic, type Diagnostic, type Range } from './diagnostics.js';
import type {
  Container,
  DataObject,
  DataStore,
  FlowNode,
  Group,
  Lane,
  Marker,
  MessageFlow,
  Model,
  NodeKind,
  Pool,
  Process,
  SequenceFlow,
  Annotation,
} from './model.js';
import { didYouMean } from './suggest.js';

export interface BuildResult {
  model: Model;
  diagnostics: Diagnostic[];
}

export interface BuildOptions {
  /** The default for `option xor-join`; the directive overrides it. */
  xorJoin?: Model['xorJoin'];
}

/** Builds the process model from an AST (architecture §4). Never throws. */
export function build(ast: Document, options: BuildOptions = {}): BuildResult {
  return new Builder(ast, options).run();
}

const NODE_KIND: Record<ElementKind, NodeKind> = {
  start: 'startEvent',
  end: 'endEvent',
  catch: 'intermediateCatchEvent',
  throw: 'intermediateThrowEvent',
  on: 'boundaryEvent',
  task: 'task',
  user: 'userTask',
  service: 'serviceTask',
  script: 'scriptTask',
  send: 'sendTask',
  receive: 'receiveTask',
  manual: 'manualTask',
  rule: 'businessRuleTask',
  call: 'callActivity',
  sub: 'subProcess',
  xor: 'exclusiveGateway',
  and: 'parallelGateway',
  or: 'inclusiveGateway',
  event: 'eventBasedGateway',
};
const ACTIVITIES = new Set<NodeKind>([
  'task',
  'userTask',
  'serviceTask',
  'scriptTask',
  'sendTask',
  'receiveTask',
  'manualTask',
  'businessRuleTask',
  'callActivity',
  'subProcess',
]);
/** The join a split's open branches merge through (notation §7.1). */
const JOIN_KIND = {
  xor: 'exclusiveGateway',
  event: 'exclusiveGateway',
  and: 'parallelGateway',
  fork: 'parallelGateway',
  or: 'inclusiveGateway',
} as const;
type SplitKind = keyof typeof JOIN_KIND;
const MARKERS = new Set(['loop', 'parallel', 'sequential']);
/** Attributes that become model fields; any other is kept in `extra`. */
const HANDLED = new Set([
  'id',
  'loop',
  'parallel',
  'sequential',
  'reads',
  'writes',
  'collapsed',
  'non-interrupting',
  'collection',
  'lane',
  'doc',
  'fit',
]);

/** A point flow continues from, and the label/default of its next flow. */
interface End {
  node: FlowNode;
  label?: string;
  isDefault?: boolean;
}
/**
 * Open ends, as a tree: the branches of a split stay grouped until the next
 * statement, where they merge through a join of their split's kind.
 */
interface Open {
  kind?: SplitKind;
  items: (End | Open)[];
}
const isEnd = (x: End | Open): x is End => 'node' in x;
const none = (): Open => ({ items: [] });
/** Flow continues from `node` unless it is an end event. */
const from = (node: FlowNode): Open =>
  node.kind === 'endEvent' ? none() : { items: [{ node }] };
const ends = (o: Open): End[] =>
  o.items.flatMap((i) => (isEnd(i) ? [i] : ends(i)));

interface PoolBuild {
  pool: Pool;
  usesLanes: boolean;
}
interface Ctx {
  pool: PoolBuild;
  process: Process;
  container: Container;
  /** The subprocess whose body this is. */
  sub?: FlowNode;
  lane?: Lane;
  group?: Group | undefined;
}
interface NodeInfo {
  pool: PoolBuild;
  container: Container;
  sub?: FlowNode;
  lane?: Lane;
  group?: Group;
  host?: FlowNode;
  explicitId?: string | undefined;
  reads: (DataObject | DataStore)[];
  writes: (DataObject | DataStore)[];
  /** Inserted joins: the element the join leads into, for its ID. */
  joinTarget?: FlowNode;
}
interface FlowBuild {
  flow: SequenceFlow;
  from: FlowNode;
  to: FlowNode;
}
type Endpoint = FlowNode | PoolBuild;
interface PendingSequence {
  from: FlowNode;
  ref: Ref;
  label?: string;
  isDefault?: boolean;
}
interface PendingMessage {
  from: Endpoint | Ref;
  to: Endpoint | Ref;
  label?: string;
  range: Range;
}
type Documented = { documentation?: string };

const normalise = (name: string) =>
  name.trim().replace(/\s+/g, ' ').toLowerCase();
const isPool = (e: Endpoint | Ref): e is PoolBuild => 'usesLanes' in e;
const isRef = (e: Endpoint | Ref): e is Ref => 'type' in e && e.type === 'ref';

class Builder {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly model: Model = {
    xorJoin: 'gateway',
    collaboration: false,
    pools: [],
    messageFlows: [],
    dataStores: [],
    groups: [],
  };
  private readonly pools: PoolBuild[] = [];
  private readonly nodes: FlowNode[] = [];
  private readonly info = new Map<FlowNode, NodeInfo>();
  private readonly flows: FlowBuild[] = [];
  private readonly pendingSequence: PendingSequence[] = [];
  private readonly pendingMessages: PendingMessage[] = [];
  private readonly messageEnds = new Map<MessageFlow, [Endpoint, Endpoint]>();
  private readonly annotationHosts = new Map<Annotation, FlowNode>();
  private readonly groups = new Map<string, Group>();
  private readonly stores = new Map<string, DataStore>();
  private readonly dataObjects = new Map<Process, Map<string, DataObject>>();
  /** Explicit `@id`s, with where each was first written. */
  private readonly explicitIds = new Map<string, Range>();

  constructor(
    private readonly ast: Document,
    private readonly options: BuildOptions,
  ) {}

  run(): BuildResult {
    if (this.options.xorJoin) this.model.xorJoin = this.options.xorJoin;
    this.directives();
    const body = this.ast.body;
    if (body.some((s) => s.type === 'pool')) {
      this.model.collaboration = true;
      let docTarget: Documented | undefined = this.model;
      for (const s of body) {
        if (s.type === 'pool') {
          this.pool(s);
          docTarget = undefined;
        } else if (s.type === 'message')
          this.message(s.source, s.step, s.range);
        else if (s.type === 'doc' && docTarget)
          this.document(docTarget, s.text);
        else if (s.type === 'data' && s.kind === 'store')
          this.store(s.name.value, s.range);
        else
          this.error(
            s.range,
            'In a document with pools, this must be inside a pool.',
          );
      }
    } else {
      // A plain process: one implicit pool, drawn only if it has lanes.
      const usesLanes = containsLanes(body);
      const pb = this.newPool(
        this.model.title ?? 'Process',
        false,
        true,
        usesLanes,
        body[0]?.range ?? this.ast.range,
      );
      this.model.collaboration = usesLanes;
      this.walkPool(pb, body, this.model);
    }
    this.resolve();
    this.assignIds();
    this.model.groups = [...this.groups.values()];
    this.model.dataStores = [...this.stores.values()];
    return { model: this.model, diagnostics: this.diagnostics };
  }

  private error(range: Range, message: string) {
    this.diagnostics.push(diagnostic('BT001', message, range));
  }

  private directives() {
    for (const d of this.ast.directives) {
      if (d.type === 'title') this.model.title = d.value.value;
      else if (
        d.key.value === 'xor-join' &&
        (d.value.value === 'gateway' || d.value.value === 'direct')
      ) {
        this.model.xorJoin = d.value.value;
      } else {
        this.error(
          d.range,
          'Unknown option. Supported: `option xor-join gateway` and `option xor-join direct`.',
        );
      }
    }
  }

  private document(target: Documented, text: string) {
    target.documentation = target.documentation
      ? `${target.documentation}\n${text}`
      : text;
  }

  /** `[doc: …]`, and attributes kept for later stages such as colours (#61). */
  private commonAttrs(
    target: Documented & { extra: Record<string, string> },
    attrs: Attr[],
  ) {
    for (const a of attrs) {
      const value = a.values.map((v) => v.value).join(', ');
      if (a.key.value === 'doc') this.document(target, value);
      else if (!HANDLED.has(a.key.value)) target.extra[a.key.value] = value;
    }
  }

  // Pools and lanes

  private newPool(
    name: string,
    collapsed: boolean,
    implicit: boolean,
    usesLanes: boolean,
    source: Range,
  ): PoolBuild {
    const pool: Pool = {
      id: '',
      name,
      collapsed,
      implicit,
      lanes: [],
      extra: {},
      source,
    };
    if (!collapsed) {
      pool.process = {
        id: '',
        nodes: [],
        flows: [],
        annotations: [],
        dataObjects: [],
      };
      this.dataObjects.set(pool.process, new Map());
    }
    const pb = { pool, usesLanes };
    this.pools.push(pb);
    this.model.pools.push(pool);
    return pb;
  }

  private pool(s: Extract<Statement, { type: 'pool' }>) {
    const collapsed = s.attrs.some((a) => a.key.value === 'collapsed');
    if (collapsed && s.body) {
      this.error(s.name.range, 'A collapsed pool cannot have a body.');
    } else if (!collapsed && !s.body) {
      this.error(
        s.name.range,
        'Expected an indented body, or `[collapsed]` for a black-box pool.',
      );
    }
    const pb = this.newPool(
      s.name.value,
      collapsed || !s.body,
      false,
      !!s.body && containsLanes(s.body),
      s.range,
    );
    this.commonAttrs(pb.pool, s.attrs);
    if (pb.pool.process) this.walkPool(pb, s.body ?? [], pb.pool);
  }

  private walkPool(pb: PoolBuild, body: Statement[], docTarget: Documented) {
    const process = pb.pool.process!;
    this.walk(
      body,
      { pool: pb, process, container: process },
      none(),
      docTarget,
    );
    // Elements before the first lane (reported as BT230) join the first lane.
    const first = pb.pool.lanes[0];
    if (pb.usesLanes && first) {
      for (const info of this.info.values()) {
        if (info.pool === pb && !info.sub && !info.lane && !info.host)
          info.lane = first;
      }
    }
  }

  private lane(
    pb: PoolBuild,
    name: string,
    source: Range,
    attrs: Attr[] = [],
  ): Lane {
    let lane = pb.pool.lanes.find((l) => normalise(l.name) === normalise(name));
    if (!lane) {
      lane = { id: '', name, extra: {}, source };
      pb.pool.lanes.push(lane);
    }
    this.commonAttrs(lane, attrs);
    return lane;
  }

  // Statements

  /** Walks a block; returns the ends still open at its end. */
  private walk(
    stmts: Statement[],
    ctx: Ctx,
    open: Open,
    docTarget: Documented,
  ): Open {
    let last = docTarget;
    for (const s of stmts) {
      switch (s.type) {
        case 'element-stmt': {
          const node = this.declare(s.element, ctx);
          this.enter(open, node, ctx);
          open = this.chain(node, s.tail, ctx, none());
          open = this.boundaries(node, s.boundaries, ctx, open);
          last = node;
          break;
        }
        case 'gateway':
          [open, last] = this.gateway(s, ctx, open);
          break;
        case 'sub':
          [open, last] = this.sub(s, ctx, open);
          break;
        case 'fork':
          open = this.fork(s, ctx, open, last);
          break;
        case 'group':
          open = this.group(s, ctx, open, last);
          break;
        case 'goto':
          open = this.chain(undefined, s.tail, ctx, open);
          break;
        case 'message':
          this.message(s.source, s.step, s.range);
          break;
        case 'lane':
          if (ctx.sub)
            this.error(s.range, 'Lanes do not apply inside a subprocess.');
          else ctx.lane = this.lane(ctx.pool, s.name.value, s.range, s.attrs);
          break;
        case 'lanes':
          if (ctx.sub)
            this.error(s.range, 'Lanes do not apply inside a subprocess.');
          else
            for (const l of s.lanes)
              this.lane(ctx.pool, l.name.value, l.range, l.attrs);
          break;
        case 'note': {
          const host = this.info.has(last as FlowNode)
            ? (last as FlowNode)
            : undefined;
          if (!host) {
            this.error(s.range, 'A note must follow the element it describes.');
            break;
          }
          const annotation: Annotation = {
            id: '',
            text: s.text.value,
            attachedTo: '',
            source: s.range,
          };
          ctx.container.annotations.push(annotation);
          this.annotationHosts.set(annotation, host);
          break;
        }
        case 'doc':
          this.document(last, s.text);
          break;
        case 'data':
          if (s.kind === 'store') this.store(s.name.value, s.range);
          else {
            const collection = s.attrs.some(
              (a) => a.key.value === 'collection',
            );
            this.dataObject(ctx.process, s.name.value, s.range, collection);
          }
          break;
        case 'pool':
          this.error(s.range, 'A pool can only be declared at the top level.');
          break;
      }
    }
    return open;
  }

  /** Implicit flow into `node`: never into a start event (notation §5). */
  private enter(open: Open, node: FlowNode, ctx: Ctx) {
    if (node.kind !== 'startEvent') this.connect(open, node, ctx);
  }

  private createNode(
    kind: NodeKind,
    ctx: Ctx,
    source: Range,
    lane = ctx.lane,
  ): FlowNode {
    const node: FlowNode = {
      id: '',
      kind,
      markers: [],
      boundaries: [],
      reads: [],
      writes: [],
      extra: {},
      attributeRanges: {},
      source,
    };
    this.info.set(node, {
      pool: ctx.pool,
      container: ctx.container,
      ...(ctx.sub
        ? { sub: ctx.sub }
        : {
            ...(lane ? { lane } : {}),
            ...(ctx.group ? { group: ctx.group } : {}),
          }),
      reads: [],
      writes: [],
    });
    this.nodes.push(node);
    ctx.container.nodes.push(node);
    return node;
  }

  private declare(e: ElementDecl, ctx: Ctx): FlowNode {
    const kind = NODE_KIND[e.kind];
    let lane = ctx.lane;
    const laneAttr = e.attrs.find((a) => a.key.value === 'lane' && a.values[0]);
    if (laneAttr && !ctx.sub)
      lane = this.lane(
        ctx.pool,
        laneAttr.values[0]!.value,
        laneAttr.values[0]!.range,
      );
    if (!lane && !ctx.sub && ctx.pool.usesLanes && kind !== 'boundaryEvent') {
      this.diagnostics.push(
        diagnostic(
          'BT230',
          'This pool uses lanes, but no lane is chosen yet. Add a `lane` line above this element.',
          e.keyword.range,
        ),
      );
    }
    const node = this.createNode(kind, ctx, e.range, lane);
    const info = this.info.get(node)!;
    if (e.name) node.name = e.name.value;
    if (e.eventType) node.eventType = e.eventType;
    if (e.id) info.explicitId = this.explicitId(e.id.value, e.id.range);
    for (const a of e.attrs) {
      const key = a.key.value;
      node.attributeRanges[key] = a.key.range;
      const first = a.values[0];
      if (key === 'id' && first)
        info.explicitId = this.explicitId(first.value, first.range);
      else if (MARKERS.has(key) && ACTIVITIES.has(kind))
        node.markers.push(key as Marker);
      else if (key === 'reads' || key === 'writes') {
        for (const v of a.values)
          info[key].push(this.data(ctx.process, v.value, v.range));
      } else if (key === 'collapsed' && kind === 'subProcess')
        node.collapsed = true;
      else if (key === 'non-interrupting' && kind === 'boundaryEvent')
        node.interrupting = false;
    }
    if (kind === 'boundaryEvent') node.interrupting ??= true;
    this.commonAttrs(node, e.attrs);
    return node;
  }

  private explicitId(id: string, range: Range): string | undefined {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id)) {
      this.error(
        range,
        `\`${id}\` is not a valid ID: use letters, digits, \`_\`, \`-\` and \`.\`, starting with a letter or \`_\`.`,
      );
      return undefined;
    }
    const first = this.explicitIds.get(id);
    if (first) {
      this.diagnostics.push(
        diagnostic(
          'BT203',
          `The ID \`${id}\` is already used on line ${first.start.line}.`,
          range,
          {
            related: [{ message: 'First use', range: first }],
          },
        ),
      );
      return undefined;
    }
    this.explicitIds.set(id, range);
    return id;
  }

  /**
   * Follows a flow tail from `start`, or from the open ends for a line that
   * starts with an arrow. Returns what is open afterwards.
   */
  private chain(
    start: FlowNode | undefined,
    tail: FlowStep[],
    ctx: Ctx,
    open: Open,
  ): Open {
    let current = start;
    for (const [i, step] of tail.entries()) {
      const label = step.label?.value;
      const [first, ...more] = step.targets;
      if (step.op === 'message') {
        const to =
          first!.type === 'element' ? this.declare(first!, ctx) : first!;
        if (current)
          this.pendingMessages.push({
            from: current,
            to,
            ...(label ? { label } : {}),
            range: step.range,
          });
        else
          this.error(
            step.range,
            'A message flow needs an element before `~>`.',
          );
        continue;
      }
      const target =
        first!.type === 'element' ? this.declare(first!, ctx) : undefined;
      const sources: End[] = current
        ? [{ node: current }]
        : this.materialize(open, ctx, target);
      if (!sources.length) {
        this.error(
          step.range,
          'Nothing flows into this arrow: the previous element ends the flow.',
        );
      }
      const labelled = sources.map((e) => (label ? { ...e, label } : e));
      if (target) {
        for (const e of labelled)
          this.flow(e.node, target, step.range, e.label, e.isDefault);
        current = target;
        continue;
      }
      for (const ref of [first, ...more] as Ref[]) {
        for (const e of labelled) {
          this.pendingSequence.push({
            from: e.node,
            ref,
            ...(e.label ? { label: e.label } : {}),
            ...(e.isDefault ? { isDefault: true } : {}),
          });
        }
      }
      // A reference ends implicit flow (notation §5).
      const next = tail[i + 1];
      if (next)
        this.error(next.range, 'A chain cannot continue after a reference.');
      return none();
    }
    return current ? from(current) : open;
  }

  private boundaries(
    host: FlowNode,
    list: BoundaryStmt[],
    ctx: Ctx,
    open: Open,
  ): Open {
    const merges: Open[] = [];
    for (const b of list) {
      const event = this.declare(b.element, ctx);
      this.info.get(event)!.host = host;
      const inner = { ...ctx };
      let chain = this.chain(event, b.tail, inner, none());
      chain = this.walk(b.body, inner, chain, event);
      const dangling = ends(chain);
      if (!dangling.length) continue;
      if (event.interrupting) {
        merges.push(chain);
        continue;
      }
      for (const e of dangling) {
        e.node.endsOpenBoundaryChain = true;
        this.diagnostics.push(
          diagnostic(
            'BT241',
            'This non-interrupting boundary chain ends open. End it with `end` or a jump: merging it back would duplicate the token.',
            { start: e.node.source.start, end: e.node.source.start },
          ),
        );
      }
    }
    // Open interrupting chains merge into the host's successor (notation §10).
    return merges.length ? { kind: 'xor', items: [open, ...merges] } : open;
  }

  // Gateways, forks and groups

  private gateway(s: GatewayStmt, ctx: Ctx, open: Open): [Open, FlowNode] {
    const g = this.declare(s.element, ctx);
    this.enter(open, g, ctx);
    if (!s.branches) return [from(g), g];
    const kind = s.element.kind as 'xor' | 'and' | 'or' | 'event';
    g.branches = s.branches.length;
    const items = s.branches.map((b) => {
      if (kind === 'event') this.checkEventBranch(b);
      const end: End = { node: g };
      if (b.label) end.label = b.label.value;
      if (b.form === 'else') end.isDefault = true;
      return this.branch(b, ctx, { items: [end] }, g);
    });
    return [{ kind, items }, g];
  }

  private fork(s: ForkStmt, ctx: Ctx, open: Open, last: Documented): Open {
    const base = this.materialize(open, ctx);
    if (!base.length) {
      const start = s.range.start;
      this.diagnostics.push(
        diagnostic(
          'BT224',
          '`fork` needs an element to fan out from, but the previous element ends the flow.',
          {
            start,
            end: { ...start, col: start.col + 4, offset: start.offset + 4 },
          },
        ),
      );
    }
    const items = s.branches.map((b) =>
      this.branch(
        b,
        ctx,
        {
          items: base.map((e) =>
            b.label ? { node: e.node, label: b.label.value } : { node: e.node },
          ),
        },
        last,
      ),
    );
    return { kind: 'fork', items };
  }

  private branch(b: Branch, ctx: Ctx, open: Open, docTarget: Documented): Open {
    const inner = { ...ctx }; // lane switches are scoped to the branch
    if (b.inline) {
      const { target, tail } = b.inline;
      if (target.type === 'element') {
        const node = this.declare(target, inner);
        this.enter(open, node, inner);
        open = this.chain(node, tail, inner, none());
        docTarget = node;
      } else {
        open = this.chain(
          undefined,
          [{ op: 'sequence', targets: [target], range: target.range }, ...tail],
          inner,
          open,
        );
      }
    }
    return this.walk(b.body, inner, open, docTarget);
  }

  private checkEventBranch(b: Branch) {
    const firstStmt = b.body.find(
      (s) => s.type !== 'lane' && s.type !== 'doc' && s.type !== 'note',
    );
    const first =
      b.inline?.target ??
      (firstStmt && 'element' in firstStmt ? firstStmt.element : undefined);
    const ok =
      first?.type === 'element' &&
      (first.kind === 'receive' ||
        (first.kind === 'catch' && first.eventType !== 'link'));
    if (!ok) {
      this.diagnostics.push(
        diagnostic(
          'BT220',
          'Each branch of an event-based gateway must start with a catch event (`catch …` or `wait …`) or a receive task.',
          first?.type === 'element'
            ? first.keyword.range
            : (first?.range ?? firstStmt?.range ?? b.range),
        ),
      );
    }
  }

  /** Group blocks are transparent: flow and lane switches pass through. */
  private group(
    s: Extract<Statement, { type: 'group' }>,
    ctx: Ctx,
    open: Open,
    last: Documented,
  ): Open {
    if (ctx.group || ctx.sub) {
      this.diagnostics.push(
        diagnostic(
          'BT250',
          ctx.sub
            ? 'Groups cannot be used inside a `sub`.'
            : 'Groups cannot be nested.',
          { start: s.range.start, end: s.name.range.end },
        ),
      );
      return this.walk(s.body, ctx, open, last);
    }
    const key = normalise(s.name.value);
    let group = this.groups.get(key);
    if (!group) {
      group = {
        id: '',
        name: s.name.value,
        fit: false,
        members: [],
        extra: {},
        source: s.range,
      };
      this.groups.set(key, group);
    }
    if (s.attrs.some((a) => a.key.value === 'fit')) group.fit = true;
    this.commonAttrs(group, s.attrs);
    ctx.group = group;
    open = this.walk(s.body, ctx, open, group);
    ctx.group = undefined;
    return open;
  }

  // Subprocesses

  private sub(st: SubStmt, ctx: Ctx, open: Open): [Open, FlowNode] {
    const node = this.declare(st.element, ctx);
    if (!st.body && !node.collapsed) {
      this.error(
        st.element.range,
        'A `sub` without a body must be `[collapsed]`, as a placeholder for detail documented elsewhere.',
      );
    }
    this.enter(open, node, ctx);
    const children: Container = { nodes: [], flows: [], annotations: [] };
    node.children = children;
    if (st.body) {
      this.walk(
        st.body,
        {
          pool: ctx.pool,
          process: ctx.process,
          container: children,
          sub: node,
        },
        none(),
        node,
      );
    }
    return [this.boundaries(node, st.boundaries, ctx, from(node)), node];
  }

  // Data

  private store(name: string, source: Range): DataStore {
    const key = normalise(name);
    let store = this.stores.get(key);
    if (!store) {
      store = { id: '', name, source };
      this.stores.set(key, store);
    }
    return store;
  }

  private dataObject(
    process: Process,
    name: string,
    source: Range,
    collection = false,
  ): DataObject {
    const objects = this.dataObjects.get(process)!;
    let object = objects.get(normalise(name));
    if (!object) {
      object = { id: '', name, collection, source };
      objects.set(normalise(name), object);
      process.dataObjects.push(object);
    }
    if (collection) object.collection = true;
    return object;
  }

  /** A data store if one has this name, else a data object, created on first use. */
  private data(
    process: Process,
    name: string,
    source: Range,
  ): DataObject | DataStore {
    return (
      this.stores.get(normalise(name)) ?? this.dataObject(process, name, source)
    );
  }

  // Flows and joins

  private flow(
    from: FlowNode,
    to: FlowNode,
    range: Range,
    name?: string,
    isDefault?: boolean,
  ) {
    const flow: SequenceFlow = {
      id: '',
      sourceRef: '',
      targetRef: '',
      ...(name ? { name } : {}),
      ...(isDefault ? { isDefault: true as const } : {}),
      source: range,
    };
    this.info.get(from)!.container.flows.push(flow);
    this.flows.push({ flow, from, to });
  }

  /** Merges open ends into `to`, inserting joins where notation §7.1 requires. */
  private connect(open: Open, to: FlowNode, ctx: Ctx) {
    for (const e of this.materialize(open, ctx, to)) {
      this.flow(e.node, to, to.source, e.label, e.isDefault);
    }
  }

  /**
   * Turns open ends into plain ends. A group of two or more open branches
   * becomes a join gateway in the current lane, recursively from the
   * innermost split outwards.
   */
  private materialize(open: Open, ctx: Ctx, next?: FlowNode): End[] {
    const items = open.items.filter((i) => isEnd(i) || ends(i).length > 0);
    const direct = this.model.xorJoin === 'direct';
    const join =
      open.kind !== undefined &&
      items.length >= 2 &&
      !(direct && JOIN_KIND[open.kind] === 'exclusiveGateway');
    if (!join)
      return items.flatMap((i) =>
        isEnd(i) ? [i] : this.materialize(i, ctx, next),
      );
    const gateway = this.createNode(
      JOIN_KIND[open.kind!],
      ctx,
      next?.source ?? ctx.pool.pool.source,
    );
    gateway.generated = 'join';
    if (next) this.info.get(gateway)!.joinTarget = next;
    for (const i of items) {
      for (const e of isEnd(i) ? [i] : this.materialize(i, ctx, gateway)) {
        this.flow(e.node, gateway, gateway.source, e.label, e.isDefault);
      }
    }
    return [{ node: gateway }];
  }

  // References

  private message(source: Ref, step: FlowStep, range: Range) {
    this.pendingMessages.push({
      from: source,
      to: step.targets[0] as Ref,
      ...(step.label ? { label: step.label.value } : {}),
      range,
    });
  }

  /** Binds references: `@id` first, then normalised names (notation §6.2). */
  private resolve() {
    const byId = new Map<string, FlowNode>();
    const byName = new Map<string, FlowNode[]>();
    for (const n of this.nodes) {
      const id = this.info.get(n)!.explicitId;
      if (id) byId.set(id, n);
      if (n.name)
        byName.set(normalise(n.name), [
          ...(byName.get(normalise(n.name)) ?? []),
          n,
        ]);
    }
    const lookup = (ref: Ref, pools: boolean): Endpoint | undefined => {
      if (ref.id) {
        const node = byId.get(ref.id.value);
        if (!node)
          this.unknown(
            ref,
            `@${ref.id.value}`,
            didYouMean(ref.id.value, byId.keys()),
            true,
          );
        return node;
      }
      const name = ref.name!.value;
      const candidates: Endpoint[] = [
        ...(byName.get(normalise(name)) ?? []),
        ...(pools
          ? this.pools.filter((p) => normalise(p.pool.name) === normalise(name))
          : []),
      ];
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) {
        const where = candidates.map((c) =>
          isPool(c) ? c.pool.source : c.source,
        );
        this.diagnostics.push(
          diagnostic(
            'BT201',
            `\`${name}\` is ambiguous: ${candidates.length} elements have this name (lines ${where.map((r) => r.start.line).join(', ')}). Give the one you mean an @id and refer to it by that.`,
            ref.range,
            {
              related: where.map((range) => ({
                message: `\`${name}\` is declared here`,
                range,
              })),
            },
          ),
        );
        return undefined;
      }
      const names = [
        ...this.nodes.flatMap((n) => (n.name ? [n.name] : [])),
        ...(pools ? this.pools.map((p) => p.pool.name) : []),
      ];
      this.unknown(ref, name, didYouMean(name, names), false);
      return undefined;
    };

    for (const p of this.pendingSequence) {
      const to = lookup(p.ref, false) as FlowNode | undefined;
      if (!to) continue;
      const a = this.info.get(p.from)!;
      const b = this.info.get(to)!;
      if (a.pool !== b.pool) {
        this.diagnostics.push(
          diagnostic(
            'BT210',
            'A sequence flow cannot cross pools. Use a message flow (`~>`) instead.',
            p.ref.range,
          ),
        );
      } else if (a.container !== b.container) {
        this.diagnostics.push(
          diagnostic(
            'BT212',
            'A sequence flow cannot cross a subprocess boundary.',
            p.ref.range,
          ),
        );
      } else {
        if (p.from.generated) a.joinTarget ??= to;
        this.flow(p.from, to, p.ref.range, p.label, p.isDefault);
      }
    }

    for (const m of this.pendingMessages) {
      const from = isRef(m.from) ? lookup(m.from, true) : m.from;
      const to = isRef(m.to) ? lookup(m.to, true) : m.to;
      if (!from || !to) continue;
      const poolOf = (e: Endpoint) => (isPool(e) ? e : this.info.get(e)!.pool);
      if (poolOf(from) === poolOf(to)) {
        this.diagnostics.push(
          diagnostic(
            'BT211',
            'A message flow must connect two different pools.',
            isRef(m.to) ? m.to.range : m.range,
          ),
        );
        continue;
      }
      const flow: MessageFlow = {
        id: '',
        sourceRef: '',
        targetRef: '',
        ...(m.label ? { name: m.label } : {}),
        source: m.range,
      };
      this.model.messageFlows.push(flow);
      this.messageEnds.set(flow, [from, to]);
    }
  }

  private unknown(
    ref: Ref,
    written: string,
    suggestion: string | undefined,
    isId: boolean,
  ) {
    const replacement =
      suggestion && (isId ? `@${suggestion}` : quoteIfNeeded(suggestion));
    const shown = suggestion && (isId ? `@${suggestion}` : suggestion);
    this.diagnostics.push(
      diagnostic(
        'BT202',
        `Nothing is called \`${written}\`.${shown ? ` Did you mean \`${shown}\`?` : ''}`,
        ref.range,
        replacement
          ? {
              fixes: [
                {
                  title: `Change to \`${shown}\``,
                  edits: [{ range: ref.range, newText: replacement }],
                },
              ],
            }
          : {},
      ),
    );
  }

  // IDs (architecture §8)

  private assignIds() {
    const used = new Set(this.explicitIds.keys());
    const take = (wanted: string) => {
      let id = wanted;
      for (let i = 2; used.has(id); i++) id = `${wanted}_${i}`;
      used.add(id);
      return id;
    };
    const poolSlug = (pb: PoolBuild) => slug(pb.pool.name);

    for (const pb of this.pools)
      pb.pool.id = take(`Participant_${poolSlug(pb)}`);
    for (const pb of this.pools) {
      if (pb.pool.process) pb.pool.process.id = take(`Process_${poolSlug(pb)}`);
    }

    // Slugs that clash across pools are qualified with the pool's slug on
    // every side, so reordering pools never changes another pool's IDs.
    const lanes = new Map(
      this.pools.flatMap((pb) =>
        pb.pool.lanes.map(
          (l) => [l, { owner: pb, id: `Lane_${slug(l.name)}` }] as const,
        ),
      ),
    );
    for (const [lane, id] of qualify(lanes, poolSlug)) lane.id = take(id);

    const named = new Map<FlowNode, { owner: PoolBuild; id: string }>();
    const counters = new Map<string, number>();
    const joins: FlowNode[] = [];
    for (const n of this.nodes) {
      const info = this.info.get(n)!;
      if (info.explicitId) n.id = info.explicitId;
      else if (n.generated) joins.push(n);
      else named.set(n, { owner: info.pool, id: this.wantedId(n, counters) });
    }
    for (const [n, id] of qualify(named, poolSlug)) n.id = take(id);
    // Joins are named after the element they lead into.
    for (const j of joins) {
      const target = this.info.get(j)!.joinTarget;
      j.id = take(
        `Gateway_join_after_${target ? stripPrefix(target.id) : 'end'}`,
      );
    }

    for (const g of this.groups.values()) g.id = take(`Group_${slug(g.name)}`);
    for (const s of this.stores.values())
      s.id = take(`DataStore_${slug(s.name)}`);
    const objects = new Map(
      this.pools.flatMap((pb) =>
        (pb.pool.process?.dataObjects ?? []).map(
          (o) => [o, { owner: pb, id: `DataObject_${slug(o.name)}` }] as const,
        ),
      ),
    );
    for (const [o, id] of qualify(objects, poolSlug)) o.id = take(id);

    for (const n of this.nodes) {
      const info = this.info.get(n)!;
      if (info.lane) n.laneId = info.lane.id;
      if (info.group) {
        n.groupId = info.group.id;
        info.group.members.push(n.id);
      }
      if (info.host) {
        n.attachedTo = info.host.id;
        info.host.boundaries.push(n.id);
      }
      n.reads = info.reads.map((d) => d.id);
      n.writes = info.writes.map((d) => d.id);
    }
    for (const { flow, from, to } of this.flows) {
      flow.sourceRef = from.id;
      flow.targetRef = to.id;
      flow.id = take(`Flow_${stripPrefix(from.id)}__${stripPrefix(to.id)}`);
      if (flow.isDefault) from.default = flow.id;
    }
    const endpointId = (e: Endpoint) => (isPool(e) ? e.pool.id : e.id);
    for (const [flow, [from, to]] of this.messageEnds) {
      flow.sourceRef = endpointId(from);
      flow.targetRef = endpointId(to);
      flow.id = take(
        `MessageFlow_${stripPrefix(flow.sourceRef)}__${stripPrefix(flow.targetRef)}`,
      );
    }
    for (const [annotation, host] of this.annotationHosts) {
      annotation.attachedTo = host.id;
      annotation.id = take(`TextAnnotation_${stripPrefix(host.id)}`);
    }
  }

  /** `<Prefix>_<name>`, or for unnamed elements `<Prefix>_[<sub>_]<kind>_<n>`. */
  private wantedId(n: FlowNode, counters: Map<string, number>): string {
    const prefix = n.kind.endsWith('Event')
      ? 'Event'
      : n.kind.endsWith('Gateway')
        ? 'Gateway'
        : 'Activity';
    if (n.name) return `${prefix}_${slug(n.name)}`;
    const info = this.info.get(n)!;
    const parent = info.sub
      ? `${info.sub.name ? slug(info.sub.name) : 'sub'}_`
      : '';
    const what = info.host
      ? `${slug(info.host.name ?? 'activity')}_boundary`
      : (KIND_WORD[n.kind] ?? 'activity');
    const key = `${prefix}_${parent}${what}`;
    // Counted per pool, so other pools never shift the numbers.
    const counter = `${this.pools.indexOf(info.pool)}|${key}`;
    const count = (counters.get(counter) ?? 0) + 1;
    counters.set(counter, count);
    return `${key}_${count}`;
  }
}

const KIND_WORD: Partial<Record<NodeKind, string>> = {
  startEvent: 'start',
  endEvent: 'end',
  intermediateCatchEvent: 'catch',
  intermediateThrowEvent: 'throw',
  exclusiveGateway: 'xor',
  parallelGateway: 'and',
  inclusiveGateway: 'or',
  eventBasedGateway: 'event',
};

/** Whether a pool body uses lanes: `lane`, `lanes` or `[lane: …]` outside subprocesses. */
function containsLanes(stmts: Statement[]): boolean {
  const decl = (e: ElementDecl | Ref | undefined) =>
    e?.type === 'element' && e.attrs.some((a) => a.key.value === 'lane');
  const tail = (t: FlowStep[]) => t.some((s) => s.targets.some(decl));
  return stmts.some((s) => {
    switch (s.type) {
      case 'lane':
      case 'lanes':
        return true;
      case 'group':
        return containsLanes(s.body);
      case 'gateway':
      case 'fork':
        return (
          ('element' in s && decl(s.element)) ||
          (s.branches ?? []).some(
            (b) =>
              containsLanes(b.body) ||
              decl(b.inline?.target) ||
              tail(b.inline?.tail ?? []),
          )
        );
      case 'element-stmt':
        return (
          decl(s.element) ||
          tail(s.tail) ||
          s.boundaries.some(
            (b) => decl(b.element) || tail(b.tail) || containsLanes(b.body),
          )
        );
      case 'sub':
        return decl(s.element);
      case 'goto':
        return tail(s.tail);
      default:
        return false;
    }
  });
}

/** A readable, ID-safe slug: lower case, `_` between words. */
export function slug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'unnamed'
  );
}

const stripPrefix = (id: string) =>
  id.replace(/^(Event|Activity|Gateway|Participant)_/, '');

function quoteIfNeeded(name: string): string {
  return /->|-\(|~>|~\(|@|\[|\s#|,|:(\s|$)|^"/.test(name)
    ? JSON.stringify(name)
    : name;
}

/**
 * Qualifies wanted IDs that clash between different owners with each
 * owner's slug, on every side of the clash.
 */
function qualify<T, O>(
  wanted: Map<T, { owner: O; id: string }>,
  ownerSlug: (o: O) => string,
): Map<T, string> {
  const owners = new Map<string, Set<O>>();
  for (const { owner, id } of wanted.values()) {
    owners.set(id, (owners.get(id) ?? new Set()).add(owner));
  }
  const result = new Map<T, string>();
  for (const [t, { owner, id }] of wanted) {
    const [prefix, ...rest] = id.split('_');
    result.set(
      t,
      owners.get(id)!.size > 1
        ? `${prefix}_${ownerSlug(owner)}_${rest.join('_')}`
        : id,
    );
  }
  return result;
}
