import type { NodeKind } from '@bpmn-text/core';

export interface Size {
  width: number;
  height: number;
}

/** Standard BPMN sizes (architecture §6.2, phase 0). */
export function nodeSize(kind: NodeKind): Size {
  if (kind.endsWith('Event')) return { width: 36, height: 36 };
  if (kind.endsWith('Gateway')) return { width: 50, height: 50 };
  return { width: 100, height: 80 };
}

// Advance widths of Arial (identical to Helvetica) in 1/1000 em, for the
// printable ASCII characters from space (32) to tilde (126). bpmn-js draws
// labels in Arial, and a table gives the same sizes in Node and browsers.
// prettier-ignore
const widths = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];
/** For characters outside the table: the width of a digit. */
const fallback = 556;

/** bpmn-js draws external labels in 11px Arial, 90px wide at most. */
export const LABEL_FONT_SIZE = 11;
export const LABEL_LINE_HEIGHT = 14;
export const LABEL_MAX_WIDTH = 90;

/** The width of `text` in pixels at `fontSize`. */
export function textWidth(text: string, fontSize = LABEL_FONT_SIZE): number {
  let units = 0;
  for (const char of text) {
    units += widths[char.codePointAt(0)! - 32] ?? fallback;
  }
  return (units * fontSize) / 1000;
}

/**
 * The size of an external label: `text` wrapped at word boundaries to
 * `maxWidth`, rounded up to whole pixels. A word wider than `maxWidth`
 * gets a line of its own.
 */
export function labelSize(text: string, maxWidth = LABEL_MAX_WIDTH): Size {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1);
    if (last !== undefined && textWidth(`${last} ${word}`) <= maxWidth) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return {
    width: Math.ceil(Math.max(0, ...lines.map((l) => textWidth(l)))),
    height: lines.length * LABEL_LINE_HEIGHT,
  };
}
