/** A position in the source. `line` and `col` are 1-based; `offset` is 0-based. */
export interface Position {
  line: number;
  col: number;
  offset: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export type Severity = 'error' | 'warning' | 'info';

/** Every diagnostic code, with its default severity (notation §11). */
export const diagnosticCodes = {
  BT001: {
    severity: 'error',
    meaning: 'Syntax error (unexpected token / malformed statement)',
  },
  BT002: { severity: 'error', meaning: 'Tab used for indentation' },
  BT003: {
    severity: 'error',
    meaning: 'Inconsistent dedent (does not match any open block)',
  },
  BT004: { severity: 'error', meaning: 'Unterminated string' },
  BT101: {
    severity: 'error',
    meaning: 'Unknown keyword (with "did you mean …?")',
  },
  BT102: {
    severity: 'error',
    meaning: 'Event type not allowed here (e.g. `start terminate`)',
  },
  BT103: { severity: 'warning', meaning: 'Unknown attribute' },
  BT104: { severity: 'error', meaning: 'Invalid colour value' },
  BT201: { severity: 'error', meaning: 'Ambiguous reference' },
  BT202: {
    severity: 'error',
    meaning: 'Unknown reference (with closest-name suggestion)',
  },
  BT203: { severity: 'error', meaning: 'Duplicate `@id`' },
  BT210: { severity: 'error', meaning: 'Sequence flow crosses pools' },
  BT211: { severity: 'error', meaning: 'Message flow within one pool' },
  BT212: { severity: 'error', meaning: 'Flow crosses subprocess boundary' },
  BT220: {
    severity: 'error',
    meaning: 'Invalid branch start for event-based gateway',
  },
  BT221: {
    severity: 'error',
    meaning: '`else:` on a parallel or event-based gateway',
  },
  BT222: { severity: 'warning', meaning: 'Gateway with a single branch' },
  BT224: {
    severity: 'error',
    meaning: '`fork` without an open preceding element',
  },
  BT230: {
    severity: 'error',
    meaning: 'Element before first lane in a pool with lanes',
  },
  BT240: { severity: 'error', meaning: 'Invalid boundary event configuration' },
  BT241: {
    severity: 'warning',
    meaning: 'Non-interrupting boundary chain ends open',
  },
  BT250: {
    severity: 'error',
    meaning: 'Nested group, element in two groups, or group inside a `sub`',
  },
  BT251: { severity: 'warning', meaning: 'Conflicting lane attributes' },
  BT301: {
    severity: 'warning',
    meaning:
      'Unreachable element (no incoming sequence or message flow, not a start event)',
  },
  BT302: {
    severity: 'warning',
    meaning: 'Dead end (non-end element with no outgoing flow)',
  },
  BT303: { severity: 'info', meaning: 'Process has no start or no end event' },
  BT304: {
    severity: 'info',
    meaning: 'Send/receive element without a message flow',
  },
} as const satisfies Record<string, { severity: Severity; meaning: string }>;

export type DiagnosticCode = keyof typeof diagnosticCodes;

/** A replacement of the text in `range`; an empty range inserts. */
export interface TextEdit {
  range: Range;
  newText: string;
}

export interface QuickFix {
  title: string;
  edits: TextEdit[];
}

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  range: Range;
  /** Other places involved, such as the candidates of an ambiguous reference. */
  related?: { message: string; range: Range }[];
  fixes?: QuickFix[];
}

/** Creates a diagnostic with the code's default severity. */
export function diagnostic(
  code: DiagnosticCode,
  message: string,
  range: Range,
  extra: Pick<Diagnostic, 'related' | 'fixes'> = {},
): Diagnostic {
  return {
    code,
    severity: diagnosticCodes[code].severity,
    message,
    range,
    ...extra,
  };
}
