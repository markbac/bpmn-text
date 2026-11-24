import type {
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import {
  StreamLanguage,
  type StreamParser,
  type StringStream,
} from '@codemirror/language';
import {
  referenceText,
  suggest,
  vocabulary,
  type CompletionData,
  type Suggestion,
} from '@bpmn-text/core';

const keywords = new Set<string>(vocabulary.keywords);
const eventTypes = vocabulary.eventTypes as Record<string, readonly string[]>;
const flags = new Set<string>(vocabulary.flags);

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

export { referenceText, suggest, type CompletionData, type Suggestion };

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
