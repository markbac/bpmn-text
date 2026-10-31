// Spike (#3): a minimal stand-in for the IR of architecture §4, and the
// models of examples 02, 03 and 04 built by hand (there is no parser yet).

export type Kind =
  | 'start'
  | 'end'
  | 'task'
  | 'user'
  | 'service'
  | 'send'
  | 'receive'
  | 'xor'
  | 'and'
  | 'or';

export interface SpikeNode {
  id: string;
  kind: Kind;
  name?: string;
  lane?: string;
}
export interface SpikeFlow {
  id: string;
  source: string;
  target: string;
  name?: string;
  isDefault?: boolean;
}
export interface SpikePool {
  id: string;
  name: string;
  collapsed: boolean;
  lanes: { id: string; name: string }[];
  nodes: SpikeNode[]; // document order
  flows: SpikeFlow[];
}
export interface SpikeModel {
  title: string;
  implicitPool: boolean; // a plain process: no participant is drawn
  pools: SpikePool[];
  messageFlows: SpikeFlow[];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

const prefix: Record<Kind, string> = {
  start: 'Event',
  end: 'Event',
  task: 'Activity',
  user: 'Activity',
  service: 'Activity',
  send: 'Activity',
  receive: 'Activity',
  xor: 'Gateway',
  and: 'Gateway',
  or: 'Gateway',
};

/** Builds one pool. Nodes and flows refer to each other by name. */
function pool(
  name: string,
  lanes: string[],
  build: (
    node: (kind: Kind, name: string, lane?: string) => void,
    flow: (source: string, target: string, label?: string) => void,
  ) => void,
  options: { defaults?: [string, string][] } = {},
): SpikePool {
  const p: SpikePool = {
    id: `Participant_${slug(name)}`,
    name,
    collapsed: false,
    lanes: lanes.map((l) => ({ id: `Lane_${slug(l)}`, name: l })),
    nodes: [],
    flows: [],
  };
  const byName = new Map<string, SpikeNode>();
  const pending: [string, string, string | undefined][] = [];
  build(
    (kind, nodeName, lane) => {
      const node: SpikeNode = { id: `${prefix[kind]}_${slug(nodeName)}`, kind };
      if (!nodeName.startsWith('(')) node.name = nodeName;
      if (lane) node.lane = `Lane_${slug(lane)}`;
      p.nodes.push(node);
      byName.set(nodeName, node);
    },
    (source, target, label) => pending.push([source, target, label]),
  );
  for (const [source, target, label] of pending) {
    const s = byName.get(source)!.id;
    const t = byName.get(target)!.id;
    const flow: SpikeFlow = { id: `Flow_${s}__${t}`, source: s, target: t };
    if (label) flow.name = label;
    if (options.defaults?.some(([a, b]) => a === source && b === target)) {
      flow.isDefault = true;
    }
    p.flows.push(flow);
  }
  return p;
}

/** examples/02-gateways.bpmnt: a plain process with a loop and joins. */
export const gateways: SpikeModel = {
  title: 'Article publishing',
  implicitPool: true,
  messageFlows: [],
  pools: [
    pool(
      'Article publishing',
      [],
      (node, flow) => {
        node('start', 'Draft ready');
        node('task', 'Write article');
        node('user', 'Review article');
        node('xor', 'Approved?');
        node('task', 'Apply feedback');
        node('end', 'Article dropped');
        node('and', '(split)');
        node('task', 'Create images');
        node('task', 'Write social posts');
        node('task', 'Translate article');
        node('and', '(join)');
        node('or', 'Extra channels?');
        node('service', 'Add to newsletter');
        node('task', 'Record audio version');
        node('or', '(or join)');
        node('task', 'Publish');
        node('end', 'Published');
        flow('Draft ready', 'Write article');
        flow('Write article', 'Review article');
        flow('Review article', 'Approved?');
        flow('Approved?', '(split)', 'yes');
        flow('Approved?', 'Apply feedback', 'needs changes');
        flow('Apply feedback', 'Write article');
        flow('Approved?', 'Article dropped', 'rejected');
        flow('(split)', 'Create images');
        flow('(split)', 'Write social posts');
        flow('(split)', 'Translate article');
        flow('Create images', '(join)');
        flow('Write social posts', '(join)');
        flow('Translate article', '(join)');
        flow('(join)', 'Extra channels?');
        flow('Extra channels?', 'Add to newsletter', 'newsletter');
        flow('Extra channels?', 'Record audio version', 'podcast');
        flow('Extra channels?', '(or join)', 'else');
        flow('Add to newsletter', '(or join)');
        flow('Record audio version', '(or join)');
        flow('(or join)', 'Publish');
        flow('Publish', 'Published');
      },
      { defaults: [['Extra channels?', '(or join)']] },
    ),
  ],
};

/** examples/03-lanes.bpmnt: one pool, three lanes, lane switches in branches. */
export const lanes: SpikeModel = {
  title: 'Leave request',
  implicitPool: false,
  messageFlows: [],
  pools: [
    pool('HR department', ['Employee', 'Manager', 'HR'], (node, flow) => {
      node('start', 'Leave needed', 'Employee');
      node('user', 'Submit leave request', 'Employee');
      node('user', 'Review request', 'Manager');
      node('xor', 'Approved?', 'Manager');
      node('service', 'Update leave balance', 'HR');
      node('user', 'Read rejection reason', 'Employee');
      node('end', 'Request rejected', 'Employee');
      node('user', 'Inform team', 'Manager');
      node('end', 'Leave booked', 'Employee');
      flow('Leave needed', 'Submit leave request');
      flow('Submit leave request', 'Review request');
      flow('Review request', 'Approved?');
      flow('Approved?', 'Update leave balance', 'yes');
      flow('Approved?', 'Read rejection reason', 'no');
      flow('Read rejection reason', 'Request rejected');
      flow('Update leave balance', 'Inform team');
      flow('Inform team', 'Leave booked');
    }),
  ],
};

const customer = pool('Customer', [], (node, flow) => {
  node('start', 'Need product');
  node('send', 'Place order');
  node('receive', 'Confirmation');
  node('end', 'Done');
  flow('Need product', 'Place order');
  flow('Place order', 'Confirmation');
  flow('Confirmation', 'Done');
});
const company = pool(
  'Company',
  ['Sales', 'Warehouse', 'Finance'],
  (node, flow) => {
    node('receive', 'Receive order', 'Sales');
    node('task', 'Check credit', 'Sales');
    node('xor', 'Credit OK?', 'Sales');
    node('task', 'Pick items', 'Warehouse');
    node('task', 'Pack parcel', 'Warehouse');
    node('send', 'Request prepayment', 'Sales');
    node('receive', 'Payment received', 'Sales');
    node('xor', '(join)', 'Finance');
    node('task', 'Issue invoice', 'Finance');
    node('task', 'Ship parcel', 'Warehouse');
    node('send', 'Send confirmation', 'Warehouse');
    node('end', 'Shipped', 'Warehouse');
    flow('Receive order', 'Check credit');
    flow('Check credit', 'Credit OK?');
    flow('Credit OK?', 'Pick items', 'yes');
    flow('Pick items', 'Pack parcel');
    flow('Credit OK?', 'Request prepayment', 'no');
    flow('Request prepayment', 'Payment received');
    flow('Pack parcel', '(join)');
    flow('Payment received', '(join)');
    flow('(join)', 'Issue invoice');
    flow('Issue invoice', 'Ship parcel');
    flow('Ship parcel', 'Send confirmation');
    flow('Send confirmation', 'Shipped');
  },
);
const bank: SpikePool = {
  id: 'Participant_bank',
  name: 'Bank',
  collapsed: true,
  lanes: [],
  nodes: [],
  flows: [],
};

/** examples/04-collaboration.bpmnt: two expanded pools and a collapsed one. */
export const collaboration: SpikeModel = {
  title: 'Order fulfilment',
  implicitPool: false,
  pools: [customer, company, bank],
  messageFlows: [
    ['Activity_place_order', 'Activity_receive_order'],
    ['Activity_request_prepayment', 'Participant_bank', 'invoice'],
    ['Participant_bank', 'Activity_payment_received', 'payment'],
    ['Activity_send_confirmation', 'Activity_confirmation'],
  ].map(([source, target, name]) => {
    const flow: SpikeFlow = {
      id: `MessageFlow_${source}__${target}`,
      source: source!,
      target: target!,
    };
    if (name) flow.name = name;
    return flow;
  }),
};
