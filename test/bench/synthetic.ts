/** The shape of a synthetic diagram for benchmarks (#50). */
export interface Size {
  /** Flow nodes in total, including inserted joins (roughly). */
  nodes: number;
  pools: number;
  /** Lanes per pool; 1 means no lanes. */
  lanes: number;
}

/**
 * A deterministic, valid bpmn-text document of about `nodes` flow nodes:
 * in each pool a chain of tasks with a decision every few steps and lane
 * switches, and message flows from each pool to the next.
 */
export function synthetic({ nodes, pools, lanes }: Size): string {
  const out: string[] = [];
  const perPool = Math.floor(nodes / pools);
  for (let p = 0; p < pools; p++) {
    const indent = pools > 1 || lanes > 1 ? '  ' : '';
    if (indent) out.push(`pool P${p}`);
    const laneNames = Array.from({ length: lanes }, (_, l) => `P${p} L${l}`);
    if (lanes > 1) out.push(`${indent}lanes ${laneNames.join(', ')}`);
    const lane = (i: number) => {
      if (lanes > 1) out.push(`${indent}lane ${laneNames[i % lanes]}`);
    };
    lane(0);
    out.push(
      p > 0 ? `${indent}start message Start ${p}` : `${indent}start Start ${p}`,
    );
    // start + end + per step: a task (1), or a decision with two
    // branches and a join (4).
    let count = 2;
    for (let s = 0; count < perPool; s++) {
      if (s % 3 === 0) lane(s / 3);
      if (s % 5 === 4 && count + 4 <= perPool) {
        out.push(
          `${indent}xor Decision ${p}-${s}?`,
          `${indent}  yes: task Approve ${p}-${s}`,
          `${indent}  no: task Rework ${p}-${s}`,
        );
        count += 4;
      } else if (p + 1 < pools && s === 0) {
        out.push(`${indent}send Notify ${p} ~> Start ${p + 1}`);
        count += 1;
      } else {
        out.push(`${indent}task Step ${p}-${s}`);
        count += 1;
      }
    }
    out.push(`${indent}end End ${p}`, '');
  }
  return `${out.join('\n')}\n`;
}

/** The benchmark matrix: 50 to 500 nodes, 1 to 4 pools, 1 to 5 lanes. */
export const sizes: Size[] = [
  { nodes: 50, pools: 1, lanes: 1 },
  { nodes: 100, pools: 1, lanes: 3 },
  { nodes: 100, pools: 2, lanes: 2 },
  { nodes: 200, pools: 4, lanes: 3 },
  { nodes: 200, pools: 1, lanes: 5 },
  { nodes: 500, pools: 4, lanes: 5 },
];
