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
  dmnVocabulary,
  suggestDmn,
  type DmnCompletionData,
} from '@bpmn-text/dmn';

const keywords = new Set<string>(dmnVocabulary.keywords);
const bodyKeywords = new Set<string>(dmnVocabulary.bodyKeywords);

interface State {
  lineStart: boolean;
  inAttrs: boolean;
  /** The rest of the line is `doc` or `literal` text. */
  rawLine: 'docString' | 'feel' | undefined;
  /** An open `doc` or `literal` block: its indentation and kind. */
  rawBlock: { indent: number; style: 'docString' | 'feel' } | undefined;
  /** In a table row: the cell's position, and whether it is the heading row. */
  row: boolean;
  /** The annotation column has started: plain text. */
  annotation: boolean;
  /** The cell the row is in, counting from 0 after the first bar. */
  cell: number;
  /** The table's annotation column, from its heading. */
  annotationColumn: number | undefined;
  /** The next row is a table's heading. */
  headingNext: boolean;
  /** In a heading row: names and types, not FEEL tests. */
  heading: boolean;
}

/** FEEL words worth marking in cells and literals. */
const FEEL_KEYWORDS =
  /^(if|then|else|for|in|return|some|every|satisfies|and|or|not|between|instance|of|function|null|true|false)\b/;

/**
 * The `.dmnt` highlighter: keywords, attributes, strings, comments, IDs,
 * table rows (cell bars, `->`, `//` and FEEL in cells) and literal text.
 */
export const dmnTextParser: StreamParser<State> = {
  name: 'dmn-text',
  startState: () => ({
    lineStart: true,
    inAttrs: false,
    rawLine: undefined,
    rawBlock: undefined,
    row: false,
    annotation: false,
    cell: -1,
    annotationColumn: undefined,
    headingNext: false,
    heading: false,
  }),
  copyState: (s) => ({ ...s, rawBlock: s.rawBlock && { ...s.rawBlock } }),
  token(stream: StringStream, state: State): string | null {
    if (stream.sol()) {
      state.lineStart = true;
      state.inAttrs = false;
      state.rawLine = undefined;
      state.row = false;
      state.annotation = false;
      if (state.rawBlock) {
        if (
          stream.indentation() > state.rawBlock.indent ||
          /^\s*$/.test(stream.string)
        ) {
          if (state.rawBlock.style === 'docString') {
            stream.skipToEnd();
            return 'docString';
          }
          state.rawLine = 'feel';
        } else state.rawBlock = undefined;
      }
    }
    if (stream.eatSpace()) return null;
    const token = read(stream, state);
    state.lineStart = false;
    return token;
  },
};

function feel(stream: StringStream): string | null {
  if (stream.peek() === '"') {
    stream.next();
    let escaped = false;
    for (let c = stream.next(); c !== undefined; c = stream.next()) {
      if (c === '"' && !escaped) break;
      escaped = c === '\\' && !escaped;
    }
    return 'string';
  }
  if (stream.match(/^-?\d+(\.\d+)?/)) return 'number';
  if (stream.match(FEEL_KEYWORDS)) return 'keyword';
  if (stream.match(/^(<=|>=|!=|\.\.|[<>=+*/-])/)) return 'operator';
  if (stream.match(/^[[\]()]/)) return 'bracket';
  if (!stream.match(/^[^\s"|[\]()<>=+*/,-]+/)) stream.next();
  return null;
}

function read(stream: StringStream, state: State): string | null {
  if (state.rawLine === 'docString') {
    stream.skipToEnd();
    return 'docString';
  }
  if (state.rawLine === 'feel') return feel(stream);
  if (state.row) {
    if (stream.match(/^\\\|/)) return null;
    if (stream.eat('|')) {
      state.cell++;
      if (!state.heading && state.cell === state.annotationColumn)
        state.annotation = true;
      return 'punctuation';
    }
    if (state.annotation) {
      stream.match(/^[^|]+/);
      return 'comment';
    }
    if (stream.match(/^->/)) return 'operator';
    if (stream.match(/^\/\//)) {
      state.annotation = true;
      state.annotationColumn = state.cell;
      return 'operator';
    }
    if (state.heading) {
      // `Name: type in values`: the type stands out, the rest is a name.
      if (stream.match(/^:\s*\w+/)) return 'typeName';
      if (!stream.match(/^[^|:\\]+/)) stream.next();
      return null;
    }
    return feel(stream);
  }
  if (state.lineStart && stream.peek() === '|') {
    state.row = true;
    state.heading = state.headingNext;
    state.headingNext = false;
    state.cell = 0;
    if (state.heading) state.annotationColumn = undefined;
    stream.next();
    return 'punctuation';
  }
  if (stream.peek() === '#' && !state.inAttrs) {
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
  if (state.inAttrs) {
    const word = stream.match(/^[^\s,\]:]+/) as RegExpMatchArray | null;
    if (!word) {
      stream.next();
      return null;
    }
    return stream.peek() === ':' ? 'attributeName' : 'atom';
  }
  if (state.lineStart) {
    const word = stream.match(/^[\w-]+/, false) as RegExpMatchArray | null;
    if (word && (keywords.has(word[0]) || bodyKeywords.has(word[0]))) {
      stream.match(/^[\w-]+/);
      const rest = stream.string.slice(stream.pos);
      state.headingNext = word[0] === 'table';
      if (word[0] === 'doc' || word[0] === 'literal') {
        const style = word[0] === 'doc' ? 'docString' : 'feel';
        if (/^\s*$/.test(rest))
          state.rawBlock = { indent: stream.indentation(), style };
        else state.rawLine = style;
      }
      return 'keyword';
    }
  }
  if (!stream.match(/^[^\s[\]@",:#]+/)) stream.next();
  return null;
}

export const dmnText = StreamLanguage.define(dmnTextParser);

/** `suggestDmn` as a CodeMirror completion source. */
export function dmnCompletionSource(data: () => DmnCompletionData) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const previous =
      line.number > 1 ? context.state.doc.line(line.number - 1).text : '';
    const result = suggestDmn(
      line.text.slice(0, context.pos - line.from),
      data(),
      previous,
    );
    if (!result) return null;
    if (!context.explicit && result.from === context.pos - line.from) {
      // Nothing typed yet: only where a list or value starts.
      if (!/(:|,|\[|\|)\s*$/.test(line.text.slice(0, result.from))) return null;
    }
    return {
      from: line.from + result.from,
      options: result.options,
      validFor: /^[^,\]|]*$/,
    };
  };
}
