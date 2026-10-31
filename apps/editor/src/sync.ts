import type { Range } from '@bpmn-text/core';

/**
 * The element whose source contains `offset`, for cursor → diagram sync
 * (FR-43): the innermost one, among the elements `drawn` accepts.
 */
export function elementAt(
  sourceMap: Record<string, Range>,
  offset: number,
  drawn: (id: string) => boolean = () => true,
): string | undefined {
  let best: string | undefined;
  let size = Infinity;
  for (const [id, r] of Object.entries(sourceMap)) {
    if (offset < r.start.offset || offset > r.end.offset || !drawn(id))
      continue;
    const span = r.end.offset - r.start.offset;
    // Ties: shapes before the flows and associations declared with them.
    if (span < size || (span === size && isFlow(best) && !isFlow(id))) {
      best = id;
      size = span;
    }
  }
  return best;
}

const isFlow = (id: string | undefined) =>
  !!id &&
  /^(Flow|MessageFlow|Association|Data(Input|Output)Association)_/.test(id);
