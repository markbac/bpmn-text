import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, type Model } from '@bpmn-text/core';
import { describe, expect, it } from 'vitest';
import {
  checkLayout,
  layout,
  type Bounds,
  type LayoutResult,
} from '../src/index.js';

const root = join(import.meta.dirname, '../../..');
const corpus = ['examples', 'test/fixtures/valid'].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.bpmnt'))
    .map((f) => `${dir}/${f}`),
);
const core = [
  'examples/01-simple.bpmnt',
  'examples/02-gateways.bpmnt',
  'examples/03-lanes.bpmnt',
  'examples/04-collaboration.bpmnt',
];
const model = (file: string) =>
  check(readFileSync(join(root, file), 'utf8')).model;
const serialise = (r: LayoutResult) =>
  JSON.stringify([[...r.shapes], [...r.edges]]);

/** Nodes in a column share a centre line: the column is its rank. */
function columns(m: Model, r: LayoutResult) {
  const nodes = m.pools.flatMap((p) =>
    (p.process?.nodes ?? []).filter((n) => !n.attachedTo),
  );
  const centre = (id: string) => {
    const s = r.shapes.get(id)!;
    return s.x + s.width / 2;
  };
  const xs = [...new Set(nodes.map((n) => centre(n.id)))].sort((a, b) => a - b);
  return (id: string) => xs.indexOf(centre(id));
}

describe.each(corpus)('layout: %s', (file) => {
  it('meets the layout invariants', async () => {
    const m = model(file);
    const report = checkLayout(m, await layout(m));
    expect(report.problems).toEqual([]);
  });

  it('is deterministic', async () => {
    const m = model(file);
    expect(serialise(await layout(m))).toBe(serialise(await layout(m)));
  });
});

describe.each(core)('layout order: %s', (file) => {
  it('follows the story: forward flows go right, loops go back', async () => {
    const m = model(file);
    const r = await layout(m);
    const column = columns(m, r);
    const offset = new Map(
      m.pools.flatMap((p) =>
        (p.process?.nodes ?? []).map((n) => [n.id, n.source.start.offset]),
      ),
    );
    for (const f of m.pools.flatMap((p) => p.process?.flows ?? [])) {
      const [s, t] = [offset.get(f.sourceRef)!, offset.get(f.targetRef)!];
      if (t > s)
        expect(column(f.targetRef), f.id).toBeGreaterThan(column(f.sourceRef));
      if (t < s)
        expect(column(f.targetRef), f.id).toBeLessThanOrEqual(
          column(f.sourceRef),
        );
    }
  });

  it('puts message-flow partners in the same or adjacent columns', async () => {
    const m = model(file);
    const r = await layout(m);
    const column = columns(m, r);
    const nodes = new Set(r.shapes.keys());
    for (const f of m.messageFlows) {
      if (m.pools.some((p) => p.id === f.sourceRef || p.id === f.targetRef))
        continue;
      expect(nodes.has(f.sourceRef) && nodes.has(f.targetRef)).toBe(true);
      expect(
        column(f.targetRef) - column(f.sourceRef),
        f.id,
      ).toBeGreaterThanOrEqual(0);
      expect(
        column(f.targetRef) - column(f.sourceRef),
        f.id,
      ).toBeLessThanOrEqual(1);
    }
  });
});

describe('layout details', () => {
  it('draws message flows vertically between pools with one elbow at most', async () => {
    const m = model('examples/04-collaboration.bpmnt');
    const r = await layout(m);
    for (const f of m.messageFlows) {
      const points = r.edges.get(f.id)!.waypoints;
      // Vertical, horizontal elbow in the pool gap, vertical.
      expect(points.length, f.id).toBeLessThanOrEqual(4);
      for (const [i, p] of points.slice(1).entries()) {
        const q = points[i]!;
        expect(p.x === q.x || p.y === q.y, f.id).toBe(true);
      }
    }
  });

  it('gives every lane and pool of a collaboration the same width', async () => {
    const m = model('examples/04-collaboration.bpmnt');
    const r = await layout(m);
    const right = new Set(
      m.pools
        .flatMap((p) => [p.id, ...p.lanes.map((l) => l.id)])
        .map((id) => r.shapes.get(id)!)
        .map((s) => s.x + s.width),
    );
    expect(right.size).toBe(1);
  });

  it('puts the first branch of a split on the main path', async () => {
    const m = model('examples/02-gateways.bpmnt');
    const r = await layout(m);
    const cy = (id: string) =>
      r.shapes.get(id)!.y + r.shapes.get(id)!.height / 2;
    expect(cy('Gateway_and_1')).toBe(cy('Gateway_approved'));
    expect(cy('Event_published')).toBe(cy('Event_draft_ready'));
  });

  it('uses a given ELK instance', async () => {
    const m = model('examples/01-simple.bpmnt');
    const calls: string[] = [];
    const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
    const elk = new ELK.default();
    await layout(m, {
      elk: { layout: (g) => (calls.push(g.id), elk.layout(g)) },
    });
    expect(calls).toEqual(['root']);
  });

  const inside = (a: Bounds, b: Bounds) =>
    a.x >= b.x &&
    a.y >= b.y &&
    a.x + a.width <= b.x + b.width &&
    a.y + a.height <= b.y + b.height;

  it('lays out an expanded subprocess body inside it (#33)', async () => {
    const m = model('examples/06-subprocess-data.bpmnt');
    const r = await layout(m);
    const sub = r.shapes.get('Activity_create_invoices')!;
    expect(sub.width).toBeGreaterThan(300);
    for (const id of [
      'Activity_calculate_totals',
      'Activity_generate_pdf',
      'DataObjectReference_invoice',
    ]) {
      expect(inside(r.shapes.get(id)!, sub), id).toBe(true);
    }
    // A collapsed subprocess keeps task size; its body is on its own plane.
    const collapsed = r.shapes.get('Activity_send_invoices')!;
    expect([collapsed.width, collapsed.height]).toEqual([100, 80]);
    expect(r.shapes.has('Activity_email_invoice')).toBe(true);
  });

  it('puts data below and annotations above their element (#34, #35)', async () => {
    const m = model('examples/06-subprocess-data.bpmnt');
    const r = await layout(m);
    const task = r.shapes.get('Activity_collect_billable_hours')!;
    for (const id of [
      'DataObjectReference_hours_report',
      'DataStoreReference_accounting_db',
    ]) {
      expect(r.shapes.get(id)!.y, id).toBeGreaterThan(task.y + task.height);
    }
    const note = r.shapes.get('TextAnnotation_collect_billable_hours')!;
    expect(note.y + note.height).toBeLessThan(task.y);
    const association = r.edges.get('Association_collect_billable_hours')!;
    expect(association.waypoints).toEqual([
      { x: task.x + task.width / 2, y: task.y },
      { x: task.x + task.width / 2, y: note.y + note.height },
    ]);
  });

  it('draws group boxes side by side over their columns (#60)', async () => {
    const m = model('test/fixtures/valid/groups.bpmnt');
    const r = await layout(m);
    const [ordering, delivery, after] = m.groups.map((g) =>
      r.shapes.get(g.id)!,
    );
    expect(ordering!.x + ordering!.width).toBeLessThan(delivery!.x);
    expect(delivery!.x + delivery!.width).toBeLessThan(after!.x);
    // Full height of both pools by default; `[fit]` hugs its members.
    const customer = r.shapes.get('Participant_customer')!;
    const company = r.shapes.get('Participant_company')!;
    expect(ordering!.y).toBeLessThan(customer.y + 10);
    expect(ordering!.y + ordering!.height).toBeGreaterThan(
      company.y + company.height - 10,
    );
    expect(after!.height).toBeLessThan(company.height / 2);
    expect(r.shapes.get(m.groups[0]!.id)!.label).toBeDefined();
  });

  it('fans out from an activity without a gateway (#62)', async () => {
    const m = model('test/fixtures/valid/fork.bpmnt');
    const r = await layout(m);
    const flows = m.pools[0]!.process!.flows.filter(
      (f) => f.sourceRef === 'Activity_publish_order',
    );
    expect(flows.map((f) => f.targetRef)).toEqual([
      'Activity_update_billing',
      'Activity_update_crm',
    ]);
    const task = r.shapes.get('Activity_publish_order')!;
    for (const f of flows) {
      // Both leave from the bottom, towards the lanes below.
      expect(r.edges.get(f.id)!.waypoints[0], f.id).toEqual({
        x: task.x + task.width / 2,
        y: task.y + task.height,
      });
    }
  });

  it('draws a body-less collapsed subprocess at task size (#64)', async () => {
    const m = model('test/fixtures/valid/collapsed-placeholder.bpmnt');
    const r = await layout(m);
    const s = r.shapes.get('Activity_credit_check')!;
    expect([s.width, s.height]).toEqual([100, 80]);
  });
});
