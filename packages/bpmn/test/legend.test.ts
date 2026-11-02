import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from '@bpmn-text/core';
import { expectSchemaValid } from '@bpmn-text/test-utils';
import { describe, expect, it } from 'vitest';
import { composeLegend, legend } from '../src/index.js';

const key = (source: string) => legend(check(source).model);
const names = (source: string) => key(source).entries.map((e) => e.name);

describe('legend', () => {
  it('lists only the symbols the model uses, each once', () => {
    expect(names('start\ntask A\ntask B\nend\n')).toEqual([
      'Start event',
      'End event',
      'Task',
      'Sequence flow',
    ]);
  });

  it('names events by position, type and whether they interrupt', () => {
    const list = names(`start timer
user Check
  on error Failed -> end terminate
  on timer Slow [non-interrupting] -> end message Told
catch signal Go
throw link Over
catch link Over
end
`);
    expect(list).toEqual(
      expect.arrayContaining([
        'Timer start event',
        'Signal catch event',
        'Link catch event',
        'Link throw event',
        'Error boundary event',
        'Timer boundary event, non-interrupting',
        'Terminate end event',
        'Message end event',
        'End event',
        'User task',
      ]),
    );
  });

  it('covers activities, markers, gateways, data, flows and containers', () => {
    const list = names(`store Orders
pool Customer [collapsed]
pool Shop
  lanes Sales, Warehouse
  lane Sales
  start
  send Tell [loop, reads: Orders, writes: Order (new)]
  note "By hand"
  group Fulfil
    xor Good?
      yes: call Ship
      else: task Later
  sub Hidden [collapsed]
  sub Handle [event]
    start timer Check [non-interrupting] -> end
  end
Tell ~> Customer
`);
    expect(list).toEqual(
      expect.arrayContaining([
        'Send task',
        'Loop marker',
        'Exclusive gateway',
        'Call activity',
        'Collapsed subprocess',
        'Event subprocess',
        'Non-interrupting timer start event',
        'Data object with a state',
        'Data store',
        'Sequence flow',
        'Default flow',
        'Message flow',
        'Data association',
        'Pool',
        'Collapsed pool',
        'Lane',
        'Group',
        'Text annotation',
      ]),
    );
    // Only in the state it is used in.
    expect(list).not.toContain('Data object');
  });

  it('keeps sections together, in a fixed order', () => {
    const sections = key(`pool P
  start
  xor Q?
    a: task A [writes: D]
    b: task B
  end
`).entries.map((e) => e.section);
    expect([...new Set(sections)]).toEqual([
      'Events',
      'Activities',
      'Gateways',
      'Data',
      'Flows',
      'Participants and notes',
    ]);
    expect(sections.join()).toBe([...sections].join());
  });

  it('is colourless by default, and follows option colors', () => {
    expect(key('start\nend\n').xml).not.toContain('bioc:fill');
    expect(key('option colors lanes\nstart\nend\n').xml).not.toContain(
      'bioc:fill',
    );
    const typed = key('option colors types\nstart\ntask A [color: red]\nend\n');
    expect(typed.xml).toContain('bioc:fill="#C8E6C9"');
    // The colour of the scheme, not the one written on this task.
    expect(typed.xml).toContain('bioc:fill="#BBDEFB"');
    expect(typed.xml).not.toContain(
      '#FFCDD2" color:background-color="#FFCDD2"><dc:Bounds x="10" y="1000"',
    );
  });

  it('escapes the title', () => {
    expect(key('title "A & <B>"\nstart\n').overlay).toContain(
      'A &amp; &lt;B&gt;',
    );
  });

  it('adds text and box to the exported symbols', () => {
    const k = key('start\nend\n');
    const svg = composeLegend(
      k,
      '<?xml version="1.0"?><svg width="5" height="5" viewBox="1 2 5 5"><g/></svg>\n',
    );
    expect(svg).toContain(`viewBox="0 0 ${k.width} ${k.height}"`);
    expect(svg).toContain('<g/>');
    expect(svg).toContain('Start event');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('gets more columns as it gets taller', () => {
    const short = key('start\nend\n');
    const tall = key(
      readFileSync(
        join(
          import.meta.dirname,
          '../../../examples/08-broadband-provisioning.bpmnt',
        ),
        'utf8',
      ),
    );
    expect(tall.width).toBeGreaterThan(short.width);
  });

  it('writes valid BPMN for the symbols of every example', async () => {
    const dir = join(import.meta.dirname, '../../../examples');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.bpmnt'))) {
      await expectSchemaValid(key(readFileSync(join(dir, file), 'utf8')).xml);
    }
  });
});
