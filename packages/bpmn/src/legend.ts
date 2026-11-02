import { typeStyle } from '@bpmn-text/core';
import type {
  Container,
  EventType,
  FlowNode,
  Model,
  NodeKind,
  Style,
} from '@bpmn-text/core';

/** One row of a legend: a symbol the diagram uses and what it means. */
export interface LegendEntry {
  section: LegendSection;
  name: string;
  meaning: string;
}

export type LegendSection =
  | 'Events'
  | 'Activities'
  | 'Gateways'
  | 'Data'
  | 'Flows'
  | 'Participants and notes';

/**
 * A key to the symbols a model uses, drawn apart from the diagram. `xml` holds
 * the symbols that bpmn-js draws, so they look as they do in the diagram. Give
 * the SVG of `xml` to `composeLegend` for the finished image.
 */
export interface Legend {
  entries: LegendEntry[];
  xml: string;
  width: number;
  height: number;
  /** SVG for everything else: titles, meanings and the plainer symbols. */
  overlay: string;
}

/** Semantic and DI fragments for bpmn-js, or SVG drawn directly. */
interface Drawing {
  height: number;
  bpmn?: (x: number, y: number, id: string) => { semantic: string; di: string };
  svg?: (x: number, y: number) => string;
}

interface Row extends LegendEntry {
  drawing: Drawing;
}

const INK = '#22242A';
const FONT = 'font-family="Arial, sans-serif"';
/** The order of the rows, which also keeps each section together. */
const ORDER = [
  'startEvent',
  'intermediateCatchEvent',
  'intermediateThrowEvent',
  'boundaryEvent',
  'endEvent',
  'task',
  'userTask',
  'manualTask',
  'serviceTask',
  'scriptTask',
  'sendTask',
  'receiveTask',
  'businessRuleTask',
  'callActivity',
  'subProcess',
  'subCollapsed',
  'subEvent',
  'subAdhoc',
  '~loop',
  '~parallel',
  '~sequential',
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
  'eventBasedGateway',
  'complexGateway',
  'object',
  'state',
  'collection',
  'store',
  'sequence',
  'default',
  'message',
  'dataAssociation',
  'pool',
  'blackbox',
  'lane',
  'group',
  'note',
];

const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const colourAttrs = (style?: Style) =>
  (style?.fill
    ? ` bioc:fill="${style.fill}" color:background-color="${style.fill}"`
    : '') +
  (style?.stroke
    ? ` bioc:stroke="${style.stroke}" color:border-color="${style.stroke}"`
    : '');

const shapeDi = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  style?: Style,
  attrs = '',
) =>
  `<bpmndi:BPMNShape id="${id}_di" bpmnElement="${id}"${attrs}${colourAttrs(style)}>` +
  `<dc:Bounds x="${x}" y="${y}" width="${width}" height="${height}"/></bpmndi:BPMNShape>`;

// The words for each event type. `Trigger` finishes "when …" or "if …".
const TRIGGER: Partial<Record<EventType, string>> = {
  message: 'a message arrives',
  timer: 'a time or delay is reached',
  signal: 'a broadcast signal is received',
  conditional: 'a condition becomes true',
  error: 'an error is thrown',
  escalation: 'an escalation is raised',
  compensation: 'compensation is triggered',
};
const THROWN: Partial<Record<EventType, string>> = {
  message: 'sends a message',
  signal: 'broadcasts a signal',
  error: 'throws an error',
  escalation: 'raises an escalation',
  compensation: 'triggers compensation',
};
const DEFINITION: Record<EventType, string> = {
  message: 'message',
  timer: 'timer',
  signal: 'signal',
  conditional: 'conditional',
  error: 'error',
  escalation: 'escalation',
  compensation: 'compensate',
  terminate: 'terminate',
  link: 'link',
};
const title = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function eventRow(n: FlowNode, style?: Style): Row {
  const type = n.eventType;
  const typed = type ? `${type} ` : '';
  const trigger = type && TRIGGER[type];
  const thrown = type && THROWN[type];
  let name: string;
  let meaning: string;
  switch (n.kind) {
    case 'startEvent':
      name = `${typed}start event`;
      if (n.interrupting === false) name = `non-interrupting ${name}`;
      meaning =
        n.interrupting === false
          ? `Starts this event subprocess when ${trigger}, while the rest of the process carries on.`
          : trigger
            ? `Starts the process when ${trigger}.`
            : 'Where the process starts.';
      break;
    case 'endEvent':
      name = `${typed}end event`;
      meaning =
        type === 'terminate'
          ? 'Ends the whole process at once, stopping every other path.'
          : thrown
            ? `Ends this path and ${thrown}.`
            : 'Ends this path.';
      break;
    case 'intermediateCatchEvent':
      name = `${typed}catch event`;
      meaning =
        type === 'link'
          ? 'The flow carries on here from the link throw event of the same name.'
          : `The flow waits here until ${trigger}.`;
      break;
    case 'intermediateThrowEvent':
      name = `${typed}throw event`;
      meaning =
        type === 'link'
          ? 'The flow jumps to the link catch event of the same name.'
          : thrown
            ? `Happens as the flow passes: ${thrown}, then the flow carries on.`
            : 'A milestone: records that the flow got here, then carries on.';
      break;
    default:
      name = `${typed}boundary event${n.interrupting === false ? ', non-interrupting' : ''}`;
      meaning =
        n.interrupting === false
          ? `If ${trigger} during the activity, this path also runs and the activity carries on.`
          : `If ${trigger} during the activity, the activity stops and this path runs instead.`;
  }
  name = title(name);
  const tag = n.kind[0]!.toLowerCase() + n.kind.slice(1);
  const definition = type
    ? `<bpmn:${DEFINITION[type]}EventDefinition${type === 'link' ? ' name=""' : ''}/>`
    : '';
  if (n.kind === 'boundaryEvent') {
    const host = typeStyle('task');
    return {
      section: 'Events',
      name,
      meaning,
      drawing: {
        height: 62,
        bpmn: (x, y, id) => ({
          semantic:
            `<bpmn:task id="${id}_host"/>` +
            `<bpmn:boundaryEvent id="${id}" attachedToRef="${id}_host"${n.interrupting === false ? ' cancelActivity="false"' : ''}>${definition}</bpmn:boundaryEvent>`,
          di:
            shapeDi(`${id}_host`, x, y, 90, 44, style && host) +
            shapeDi(id, x + 27, y + 26, 36, 36, style),
        }),
      },
    };
  }
  const start =
    n.kind === 'startEvent' && n.interrupting === false
      ? ' isInterrupting="false"'
      : '';
  return {
    section: 'Events',
    name,
    meaning,
    drawing: {
      height: 36,
      bpmn: (x, y, id) => ({
        semantic: `<bpmn:${tag} id="${id}"${start}>${definition}</bpmn:${tag}>`,
        di: shapeDi(id, x + 27, y, 36, 36, style),
      }),
    },
  };
}

const ACTIVITY: Partial<Record<NodeKind, [string, string]>> = {
  task: ['Task', 'A unit of work.'],
  userTask: ['User task', 'Work a person does with the help of a system.'],
  manualTask: ['Manual task', 'Work a person does without a system.'],
  serviceTask: ['Service task', 'Work a system does automatically.'],
  scriptTask: ['Script task', 'A script the process engine runs.'],
  sendTask: ['Send task', 'Sends a message.'],
  receiveTask: ['Receive task', 'Waits for a message.'],
  businessRuleTask: [
    'Business rule task',
    'Applies business rules to reach a decision.',
  ],
  callActivity: [
    'Call activity',
    'Runs a reusable process that is defined elsewhere.',
  ],
};

const GATEWAY: Partial<Record<NodeKind, [string, string]>> = {
  exclusiveGateway: [
    'Exclusive gateway',
    'A split takes exactly one path. A join passes on whichever path arrives.',
  ],
  parallelGateway: [
    'Parallel gateway',
    'A split takes every path at once. A join waits for all of them.',
  ],
  inclusiveGateway: [
    'Inclusive gateway',
    'A split takes one or more paths. A join waits for those that were taken.',
  ],
  eventBasedGateway: [
    'Event-based gateway',
    'Waits for the events that follow, and takes the path of whichever happens first.',
  ],
  complexGateway: [
    'Complex gateway',
    'Merges or splits by a rule of its own, such as "any 3 of 5 paths".',
  ],
};

const activity = (
  tag: string,
  style?: Style,
  options: { attrs?: string; inner?: string; expanded?: boolean } = {},
): Drawing => ({
  height: 56,
  bpmn: (x, y, id) => ({
    semantic: `<bpmn:${tag} id="${id}"${options.attrs ?? ''}>${options.inner ?? ''}</bpmn:${tag}>`,
    di: shapeDi(
      id,
      x,
      y,
      90,
      56,
      style,
      options.expanded === undefined ? '' : ` isExpanded="${options.expanded}"`,
    ),
  }),
});

/** A line from left to right across the symbol column. */
function line(
  x: number,
  y: number,
  options: { dash?: string; end?: string; start?: string; slash?: boolean },
): string {
  const { dash, end, start, slash } = options;
  const middle = y + 8;
  return (
    `<path d="M${x},${middle} L${x + 90},${middle}" fill="none" stroke="${INK}" stroke-width="2"` +
    (dash ? ` stroke-dasharray="${dash}"` : '') +
    (end ? ` marker-end="url(#${end})"` : '') +
    (start ? ` marker-start="url(#${start})"` : '') +
    '/>' +
    (slash
      ? `<path d="M${x + 8},${middle + 7} L${x + 18},${middle - 7}" stroke="${INK}" stroke-width="2"/>`
      : '')
  );
}

const box = (x: number, y: number, width: number, height: number, extra = '') =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="${INK}" stroke-width="2"${extra}/>`;

const MARKERS: Record<string, [string, string, string]> = {
  loop: [
    'Loop',
    'Repeats the activity for as long as its condition holds.',
    '<bpmn:standardLoopCharacteristics/>',
  ],
  parallel: [
    'Parallel multi-instance',
    'Runs the activity several times at once, such as once for each item.',
    '<bpmn:multiInstanceLoopCharacteristics/>',
  ],
  sequential: [
    'Sequential multi-instance',
    'Runs the activity several times, one after another.',
    '<bpmn:multiInstanceLoopCharacteristics isSequential="true"/>',
  ],
};

/**
 * The symbols `model` uses, each once, in a fixed order. With `option colors
 * types` or `all` they have the colours of the scheme; colours written on
 * single elements have no meaning a legend could state, so they are left out.
 */
function rows(model: Model): Row[] {
  const typed = model.colors === 'types' || model.colors === 'all';
  const styleOf = (kind: NodeKind | 'data') =>
    typed ? typeStyle(kind) : undefined;
  const found = new Map<string, Row>();
  const add = (key: string, make: () => Row) => {
    if (!found.has(key)) found.set(key, make());
  };
  const row = (
    section: LegendSection,
    name: string,
    meaning: string,
    drawing: Drawing,
  ): Row => ({ section, name, meaning, drawing });

  const walk = (c: Container) => {
    for (const n of c.nodes) {
      if (n.kind.endsWith('Event')) {
        add(`${n.kind}:${n.eventType ?? ''}:${n.interrupting === false}`, () =>
          eventRow(n, styleOf(n.kind)),
        );
      } else if (GATEWAY[n.kind]) {
        add(n.kind, () => {
          const tag = n.kind[0]!.toLowerCase() + n.kind.slice(1);
          const [name, meaning] = GATEWAY[n.kind]!;
          return row('Gateways', name, meaning, {
            height: 50,
            bpmn: (x, y, id) => ({
              semantic: `<bpmn:${tag} id="${id}"/>`,
              di: shapeDi(id, x + 20, y, 50, 50, styleOf(n.kind)),
            }),
          });
        });
      } else if (n.kind === 'subProcess') {
        const style = styleOf('subProcess');
        if (n.triggeredByEvent)
          add('subEvent', () =>
            row(
              'Activities',
              'Event subprocess',
              'Outside the normal flow: its start event starts it, whenever that event happens.',
              activity('subProcess', style, {
                attrs: ' triggeredByEvent="true"',
                expanded: true,
              }),
            ),
          );
        else if (n.adHoc)
          add('subAdhoc', () =>
            row(
              'Activities',
              'Ad-hoc subprocess',
              'Its activities run as needed, in any order, until it is complete.',
              activity('adHocSubProcess', style, { expanded: !n.collapsed }),
            ),
          );
        else if (n.collapsed)
          add('subCollapsed', () =>
            row(
              'Activities',
              'Collapsed subprocess',
              'A group of steps, with the detail hidden.',
              activity('subProcess', style, { expanded: false }),
            ),
          );
        else
          add('subProcess', () =>
            row(
              'Activities',
              'Subprocess',
              'A group of steps with a flow of its own, drawn inside it.',
              activity('subProcess', style, { expanded: true }),
            ),
          );
      } else {
        add(n.kind, () => {
          const [name, meaning] = ACTIVITY[n.kind]!;
          return row(
            'Activities',
            name,
            meaning,
            activity(
              n.kind[0]!.toLowerCase() + n.kind.slice(1),
              styleOf(n.kind),
            ),
          );
        });
      }
      for (const m of n.markers) {
        add(`~${m}`, () => {
          const [name, meaning, inner] = MARKERS[m]!;
          return row(
            'Activities',
            `${name} marker`,
            meaning,
            activity('task', styleOf('task'), { inner }),
          );
        });
      }
      if (n.default) {
        add('default', () =>
          row(
            'Flows',
            'Default flow',
            'The path taken when no other path of the gateway applies.',
            {
              height: 16,
              svg: (x, y) => line(x, y, { end: 'key-arrow', slash: true }),
            },
          ),
        );
      }
      if (n.reads.length + n.writes.length > 0) {
        add('dataAssociation', () =>
          row(
            'Flows',
            'Data association',
            'Data read by an activity or event, or written by it, as the arrow shows.',
            {
              height: 16,
              svg: (x, y) => line(x, y, { dash: '2 5', end: 'key-open' }),
            },
          ),
        );
      }
      if (n.children) walk(n.children);
    }
    if (c.flows.length > 0) {
      add('sequence', () =>
        row('Flows', 'Sequence flow', 'The order steps happen in.', {
          height: 16,
          svg: (x, y) => line(x, y, { end: 'key-arrow' }),
        }),
      );
    }
    if (c.annotations.length > 0) {
      add('note', () =>
        row(
          'Participants and notes',
          'Text annotation',
          'A note for the reader, joined by a dotted line to what it describes.',
          {
            height: 36,
            svg: (x, y) =>
              `<path d="M${x + 12},${y} L${x},${y} L${x},${y + 36} L${x + 12},${y + 36}" fill="none" stroke="${INK}" stroke-width="2"/>` +
              `<text x="${x + 8}" y="${y + 22}" ${FONT} font-size="12" fill="${INK}">Note</text>`,
          },
        ),
      );
    }
  };

  const dataStyle = styleOf('data');
  for (const p of model.pools) {
    if (!p.implicit) {
      add(p.collapsed ? 'blackbox' : 'pool', () =>
        p.collapsed
          ? row(
              'Participants and notes',
              'Collapsed pool',
              'A participant whose inner workings are not shown.',
              { height: 40, svg: (x, y) => box(x, y, 90, 40) },
            )
          : row(
              'Participants and notes',
              'Pool',
              'A participant in the process, such as a company. Only message flows cross between pools.',
              {
                height: 50,
                svg: (x, y) =>
                  box(x, y, 90, 50) +
                  `<path d="M${x + 16},${y} L${x + 16},${y + 50}" stroke="${INK}" stroke-width="2"/>`,
              },
            ),
      );
    }
    if (p.lanes.length > 0) {
      add('lane', () =>
        row(
          'Participants and notes',
          'Lane',
          'Who does the steps inside it: a role or team within the pool.',
          {
            height: 50,
            svg: (x, y) =>
              box(x, y, 90, 50) +
              `<path d="M${x + 16},${y} L${x + 16},${y + 50} M${x + 16},${y + 25} L${x + 90},${y + 25}" stroke="${INK}" stroke-width="2"/>`,
          },
        ),
      );
    }
    if (!p.process) continue;
    walk(p.process);
    const collections = new Set(
      p.process.dataObjects.filter((o) => o.collection).map((o) => o.id),
    );
    for (const r of p.process.dataObjectReferences) {
      const collection = collections.has(r.object);
      const drawing = (): Drawing => ({
        height: 50,
        bpmn: (x, y, id) => ({
          semantic:
            `<bpmn:dataObject id="${id}_object"${collection ? ' isCollection="true"' : ''}/>` +
            `<bpmn:dataObjectReference id="${id}" dataObjectRef="${id}_object"/>`,
          di: shapeDi(id, x + 27, y, 36, 50, dataStyle),
        }),
      });
      if (collection || !r.state)
        add(collection ? 'collection' : 'object', () =>
          collection
            ? row(
                'Data',
                'Data collection',
                'Several items of the same data, such as a list of orders.',
                drawing(),
              )
            : row(
                'Data',
                'Data object',
                'Information the process uses or produces.',
                drawing(),
              ),
        );
      if (r.state) {
        add('state', () =>
          row(
            'Data',
            'Data object with a state',
            'The same data at a point in its life. The state is in brackets under the name.',
            drawing(),
          ),
        );
      }
    }
    if (p.process.dataStoreReferences.length > 0) {
      add('store', () =>
        row(
          'Data',
          'Data store',
          'Where data is kept beyond this process, such as a database.',
          {
            height: 50,
            bpmn: (x, y, id) => ({
              semantic: `<bpmn:dataStoreReference id="${id}"/>`,
              di: shapeDi(id, x + 20, y, 50, 50, dataStyle),
            }),
          },
        ),
      );
    }
  }
  if (model.messageFlows.length > 0) {
    add('message', () =>
      row('Flows', 'Message flow', 'A message passed between two pools.', {
        height: 16,
        svg: (x, y) =>
          line(x, y, {
            dash: '10 6',
            end: 'key-hollow',
            start: 'key-circle',
          }),
      }),
    );
  }
  if (model.groups.length > 0) {
    add('group', () =>
      row(
        'Participants and notes',
        'Group',
        'Marks elements that belong together, such as a phase. It does not affect the flow.',
        {
          height: 50,
          svg: (x, y) =>
            box(x, y, 90, 50, ' rx="10" stroke-dasharray="10 5 2 5"'),
        },
      ),
    );
  }

  const rank = (key: string) => ORDER.indexOf(key.split(':')[0]!);
  return [...found.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([, r]) => r);
}

const SYMBOL = 90;
const GAP = 14;
const TEXT = 290;
const COLUMN = SYMBOL + GAP + TEXT + 30;
const MARGIN = 10;
const HEADER = 34;
const SECTION = 30;
const PER_LINE = 15;
const CHARS = 50;
/** Above this height, a legend gets another column. */
const TALL = 640;

/** `text` broken into lines of at most `CHARS` characters. */
function wrap(text: string): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current && current.length + 1 + word.length > CHARS) {
      lines.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  return lines;
}

/** Lays out a key to the symbols `model` uses. */
export function legend(model: Model): Legend {
  const all = rows(model);
  const heightOf = (r: Row) =>
    Math.max(r.drawing.height, 18 + wrap(r.meaning).length * PER_LINE) + 14;
  const total = all.reduce((sum, r) => sum + heightOf(r), 0);
  const sections = new Set(all.map((r) => r.section)).size;
  const body = total + sections * SECTION;
  const columns = Math.max(1, Math.min(3, Math.ceil(body / TALL)));
  const target = body / columns;

  let semantic = '';
  let di = '';
  let overlay = `<text x="${MARGIN}" y="${MARGIN + 16}" ${FONT} font-size="18" font-weight="bold" fill="${INK}">Key${model.title ? `: ${esc(model.title)}` : ''}</text>`;
  let column = 0;
  let y = MARGIN + HEADER;
  let bottom = y;
  let section: LegendSection | undefined;
  all.forEach((r, i) => {
    const needed = heightOf(r) + (r.section === section ? 0 : SECTION);
    if (
      column < columns - 1 &&
      y + needed - MARGIN - HEADER > target &&
      y > MARGIN + HEADER
    ) {
      column++;
      y = MARGIN + HEADER;
      section = undefined;
    }
    const x = MARGIN + column * COLUMN;
    if (r.section !== section) {
      section = r.section;
      overlay += `<text x="${x}" y="${y + 16}" ${FONT} font-size="14" font-weight="bold" fill="${INK}">${r.section}</text>`;
      overlay += `<path d="M${x},${y + 22} L${x + SYMBOL + GAP + TEXT},${y + 22}" stroke="#C9CCD1"/>`;
      y += SECTION;
    }
    const height = heightOf(r);
    const symbolY = y + Math.round((height - 14 - r.drawing.height) / 2);
    if (r.drawing.bpmn) {
      const drawn = r.drawing.bpmn(x, symbolY, `Key_${i}`);
      semantic += drawn.semantic;
      di += drawn.di;
    }
    if (r.drawing.svg) overlay += r.drawing.svg(x, symbolY);
    const textX = x + SYMBOL + GAP;
    overlay += `<text x="${textX}" y="${y + 12}" ${FONT} font-size="13" font-weight="bold" fill="${INK}">${esc(r.name)}</text>`;
    wrap(r.meaning).forEach((text, n) => {
      overlay += `<text x="${textX}" y="${y + 28 + n * PER_LINE}" ${FONT} font-size="12" fill="${INK}">${esc(text)}</text>`;
    });
    y += height;
    bottom = Math.max(bottom, y);
  });

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
    'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" ' +
    'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" ' +
    'xmlns:bioc="http://bpmn.io/schema/bpmn/biocolor/1.0" ' +
    'xmlns:color="http://www.omg.org/spec/BPMN/non-normative/color/1.0" ' +
    'id="Key_definitions" targetNamespace="urn:bpmn-text:legend">' +
    `<bpmn:process id="Key_process">${semantic}</bpmn:process>` +
    '<bpmndi:BPMNDiagram id="Key_diagram"><bpmndi:BPMNPlane id="Key_plane" bpmnElement="Key_process">' +
    `${di}</bpmndi:BPMNPlane></bpmndi:BPMNDiagram></bpmn:definitions>`;

  return {
    entries: all.map(({ section, name, meaning }) => ({
      section,
      name,
      meaning,
    })),
    xml,
    width: MARGIN + columns * COLUMN - 30 + MARGIN,
    height: bottom + MARGIN,
    overlay,
  };
}

const DEFS =
  `<marker id="key-arrow" viewBox="0 0 20 20" refX="11" refY="10" markerWidth="10" markerHeight="10" orient="auto"><path d="M1,5 L11,10 L1,15 Z" fill="${INK}"/></marker>` +
  `<marker id="key-open" viewBox="0 0 20 20" refX="11" refY="10" markerWidth="10" markerHeight="10" orient="auto"><path d="M1,5 L11,10 L1,15" fill="none" stroke="${INK}" stroke-width="1.5"/></marker>` +
  `<marker id="key-hollow" viewBox="0 0 20 20" refX="11" refY="10" markerWidth="10" markerHeight="10" orient="auto"><path d="M1,5 L11,10 L1,15 Z" fill="#fff" stroke="${INK}" stroke-width="1.5"/></marker>` +
  `<marker id="key-circle" viewBox="0 0 20 20" refX="6" refY="6" markerWidth="10" markerHeight="10" orient="auto"><circle cx="6" cy="6" r="3.5" fill="#fff" stroke="${INK}" stroke-width="1.5"/></marker>`;

/**
 * The finished legend, from the SVG bpmn-js exports for `legend.xml`. Symbols
 * keep the coordinates `legend` gave them, whatever box the export chose.
 */
export function composeLegend(legend: Legend, symbols: string): string {
  const { width, height, overlay } = legend;
  return symbols
    .replace(
      /<svg\b[^>]*>/,
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" version="1.1">` +
        `<defs>${DEFS}</defs>`,
    )
    .replace(/<\/svg>\s*$/, `${overlay}</svg>`);
}
