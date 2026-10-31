import { describe, expect, it } from 'vitest';
import { labelSize, nodeSize, textWidth } from '../src/index.js';

const labels = [
  'Approved?',
  'Need product',
  'Customer reopens',
  'Last working day of month',
  'Supercalifragilisticexpialidocious',
  'Größe prüfen',
  '',
];

describe('sizing', () => {
  it('uses the standard BPMN sizes', () => {
    expect(nodeSize('userTask')).toEqual({ width: 100, height: 80 });
    expect(nodeSize('subProcess')).toEqual({ width: 100, height: 80 });
    expect(nodeSize('boundaryEvent')).toEqual({ width: 36, height: 36 });
    expect(nodeSize('eventBasedGateway')).toEqual({ width: 50, height: 50 });
  });

  it('measures text with the Arial metrics', () => {
    expect(textWidth(' ~')).toBeCloseTo(((278 + 584) * 11) / 1000);
    expect(textWidth('W', 10)).toBeCloseTo(9.44);
    // Characters outside the table count as a digit.
    expect(textWidth('ö')).toBe(textWidth('0'));
  });

  it('wraps labels at word boundaries', () => {
    expect(labels.map((l) => labelSize(l))).toMatchInlineSnapshot(`
      [
        {
          "height": 14,
          "width": 54,
        },
        {
          "height": 14,
          "width": 67,
        },
        {
          "height": 28,
          "width": 48,
        },
        {
          "height": 28,
          "width": 83,
        },
        {
          "height": 14,
          "width": 158,
        },
        {
          "height": 14,
          "width": 65,
        },
        {
          "height": 0,
          "width": 0,
        },
      ]
    `);
  });
});
