import { vocabulary } from './parser.js';

const keywords = new Set<string>(vocabulary.keywords);
const eventTypes = vocabulary.eventTypes as Record<string, readonly string[]>;
const flags = new Set<string>(vocabulary.flags);

export interface CompletionData {
  /** Element and pool names from the last compile. */
  names: string[];
  lanes: string[];
}

export interface Suggestion {
  label: string;
  type: 'keyword' | 'type' | 'property' | 'variable' | 'namespace';
  apply?: string;
}

/** A name as it must be written in a reference: quoted where needed. */
export function referenceText(name: string): string {
  const first = name.split(/\s+/)[0] ?? '';
  return /->|-\(|~>|~\(|@|\[|\s#|,|:(\s|$)|^"/.test(name) || keywords.has(first)
    ? JSON.stringify(name)
    : name;
}

/**
 * Completions for the text of a line before the cursor (FR-42): keywords
 * at the start of a statement, event types after an event keyword,
 * attribute names in `[…]`, lane names after `lane`, and element names
 * after `->`, `~>` and the commas of a jump. Returns the column the
 * completed word starts at, or undefined where nothing fits.
 */
export function suggest(
  before: string,
  data: CompletionData,
): { from: number; options: Suggestion[] } | undefined {
  const at = (typed: string) => before.length - typed.length;
  const open = before.lastIndexOf('[');
  if (open > before.lastIndexOf(']')) {
    const attr = /(?:\[|,)\s*([\w-]*)$/.exec(before);
    const lane = /\blane:\s*([^,\]]*)$/.exec(before);
    if (lane) {
      return {
        from: at(lane[1]!),
        options: data.lanes.map((l) => ({ label: l, type: 'namespace' })),
      };
    }
    if (!attr) return undefined;
    return {
      from: at(attr[1]!),
      options: vocabulary.attributes.map((a) => ({
        label: a,
        type: 'property',
        ...(flags.has(a) ? {} : { apply: `${a}: ` }),
      })),
    };
  }
  const event = /(?:^\s*|->\s*|:\s*)(start|end|catch|throw|on)\s+(\w*)$/.exec(
    before,
  );
  if (event) {
    return {
      from: at(event[2]!),
      options: eventTypes[event[1]!]!.map((t) => ({ label: t, type: 'type' })),
    };
  }
  const lane = /^\s*lane\s+(.*)$/.exec(before);
  if (lane) {
    return {
      from: at(lane[1]!),
      options: data.lanes.map((l) => ({ label: l, type: 'namespace' })),
    };
  }
  const jump = /(->|~>)\s*(?:[^,]*,\s*)*([^,]*)$/.exec(before);
  if (jump && !/["]/.test(jump[2]!)) {
    const typed = jump[2]!;
    return {
      from: at(typed),
      options: [
        ...data.names.map((n) => ({
          label: n,
          type: 'variable' as const,
          apply: referenceText(n),
        })),
        ...(jump[1] === '->' && !/,\s*[^,]*$/.test(before)
          ? [...keywords]
              .filter((k) => !['pool', 'lane', 'lanes', 'title'].includes(k))
              .map((k) => ({ label: k, type: 'keyword' as const }))
          : []),
      ],
    };
  }
  const start = /^\s*([\w-]*)$/.exec(before);
  if (start) {
    return {
      from: at(start[1]!),
      options: [...keywords].map((k) => ({ label: k, type: 'keyword' })),
    };
  }
  return undefined;
}
