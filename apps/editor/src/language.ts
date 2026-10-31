import type {
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import {
  StreamLanguage,
  type StreamParser,
  type StringStream,
} from '@codemirror/language';
import { vocabulary } from '@bpmn-text/core';

const keywords = new Set<string>(vocabulary.keywords);
const eventTypes = vocabulary.eventTypes as Record<string, readonly string[]>;
const flags = new Set([
  'loop',
  'parallel',
  'sequential',
  'collapsed',
  'non-interrupting',
  'collection',
  'fit',
]);

interface State {
  /** No token read yet on this line. */
  lineStart: boolean;
  inAttrs: boolean;
  /** The rest of the line is `doc` text. */
  docLine: boolean;
  /** Indentation of a `doc` line that opens a raw block. */
  docBlock: number | undefined;
  /** An event keyword whose event type may come next. */
  eventKeyword: string | undefined;
  /** Inside a flow label: `-(` … `)->`. */
  flowLabel: boolean;
}

/** Where a bare name stops (notation §2). */
const terminator = /^(->|-\(|~>|~\(|\)->|\)~>|[@[\]",]|\s#)/;

/**
 * The highlighter (FR-42): keywords, event types, operators, strings,
 * comments, IDs, attributes, branch labels and `doc` text, which is raw.
 */
export const bpmnTextParser: StreamParser<State> = {
  name: 'bpmn-text',
  startState: () => ({
    lineStart: true,
    inAttrs: false,
    docLine: false,
    docBlock: undefined,
    eventKeyword: undefined,
    flowLabel: false,
  }),
  copyState: (s) => ({ ...s }),
  token(stream: StringStream, state: State): string | null {
    if (stream.sol()) {
      state.lineStart = true;
      state.inAttrs = false;
      state.docLine = false;
      state.eventKeyword = undefined;
      state.flowLabel = false;
      if (state.docBlock !== undefined) {
        if (stream.indentation() > state.docBlock) {
          stream.skipToEnd();
          return 'docString';
        }
        state.docBlock = undefined;
      }
    }
    if (stream.eatSpace()) return null;
    const token = read(stream, state);
    state.lineStart = false;
    return token;
  },
};

function read(stream: StringStream, state: State): string | null {
  if (state.docLine) {
    stream.skipToEnd();
    return 'docString';
  }
  if (state.flowLabel) {
    state.flowLabel = false;
    if (stream.match(/^[^)]+/)) return 'labelName';
  }
  const previous = stream.string[stream.pos - 1];
  if (
    stream.peek() === '#' &&
    !state.inAttrs &&
    (stream.pos === 0 || /\s/.test(previous ?? ''))
  ) {
    stream.skipToEnd();
    return 'comment';
  }
  if (stream.peek() === '"') {
    stream.next();
    let escaped = false;
    for (let c = stream.next(); c !== undefined; c = stream.next()) {
      if (c === '"' && !escaped) break;
      escaped = c === '\\' && !escaped;
    }
    return 'string';
  }
  if (stream.match(/^(\)->|\)~>|->|~>)/)) return 'operator';
  if (stream.match(/^(-\(|~\()/)) {
    state.flowLabel = true;
    return 'operator';
  }
  if (stream.match(/^@[A-Za-z_][\w.-]*/)) return 'meta';
  if (stream.eat('[')) {
    state.inAttrs = true;
    return 'bracket';
  }
  if (stream.eat(']')) {
    state.inAttrs = false;
    return 'bracket';
  }
  if (stream.eat(',') || stream.eat(':')) return 'punctuation';
  if (state.lineStart && stream.match(/^-(?=\s|$)/)) return 'operator';
  if (state.inAttrs) {
    const word = stream.match(/^[^\s,\]:]+/) as RegExpMatchArray | null;
    if (!word) {
      stream.next();
      return null;
    }
    return stream.peek() === ':' || flags.has(word[0])
      ? 'attributeName'
      : 'atom';
  }
  if (state.lineStart && !startsWithKeyword(stream)) {
    // A branch label: text up to a `:` that ends it.
    if (stream.match(/^[^:[\]"@]+?:(?=\s|$)/, false)) {
      stream.match(/^[^:[\]"@]+?(?=:)/);
      return 'labelName';
    }
  }
  const word = stream.match(/^[^\s[\]@",:]+/, false) as RegExpMatchArray | null;
  if (word && (keywords.has(word[0]) || word[0] === 'else')) {
    const at = stream.pos;
    stream.match(/^[^\s[\]@",:]+/);
    const keyword = word[0];
    // After an arrow, a keyword declares an element inline (§6.1).
    const inline = /(->|~>|:|^\s*-)\s*$/.test(stream.string.slice(0, at));
    if (state.lineStart || inline) {
      if (eventTypes[keyword]) state.eventKeyword = keyword;
      if (keyword === 'doc' && state.lineStart) {
        if (/^\s*$/.test(stream.string.slice(stream.pos))) {
          state.docBlock = stream.indentation();
        } else state.docLine = true;
      }
      return 'keyword';
    }
  }
  if (state.eventKeyword && word) {
    const type = word[0];
    const allowed = eventTypes[state.eventKeyword]!;
    state.eventKeyword = undefined;
    if (allowed.includes(type)) {
      stream.match(/^[^\s[\]@",:]+/);
      return 'typeName';
    }
  }
  // A run of name text, up to the next terminator.
  let moved = false;
  while (!stream.eol()) {
    if (terminator.test(stream.string.slice(stream.pos))) break;
    if (
      stream.peek() === ':' &&
      /^:(\s|$)/.test(stream.string.slice(stream.pos))
    )
      break;
    stream.next();
    moved = true;
    if (stream.peek() === ' ') break;
  }
  if (!moved) stream.next();
  return null;
}

function startsWithKeyword(stream: StringStream): boolean {
  const word = /^[^\s[\]@",:]+/.exec(stream.string.slice(stream.pos));
  return !!word && (keywords.has(word[0]) || word[0] === 'else');
}

export const bpmnText = StreamLanguage.define(bpmnTextParser);

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

/** `suggest` as a CodeMirror completion source. */
export function completionSource(data: () => CompletionData) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const result = suggest(line.text.slice(0, context.pos - line.from), data());
    if (!result) return null;
    if (!context.explicit && result.from === context.pos - line.from) {
      // Nothing typed yet: only after an arrow or a space in a jump.
      if (!/(->|~>|,|lane|\[)\s*$/.test(line.text.slice(0, result.from)))
        return null;
    }
    return {
      from: line.from + result.from,
      options: result.options,
      validFor: /^[^,\]]*$/,
    };
  };
}
