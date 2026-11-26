/** Messages from the extension to the preview webview. */
export type ToWebview =
  | { type: 'show'; xml: string; language?: 'bpmn' | 'dmn' }
  /** DMN: `decision` is the decision whose table or literal to open. */
  | { type: 'highlight'; id: string | undefined; decision?: string }
  | { type: 'export'; format: 'svg' | 'png' };

/** Messages from the preview webview to the extension. */
export type FromWebview =
  | { type: 'shown' }
  | { type: 'select'; id: string }
  /** `data` is SVG text, or a PNG as base64. */
  | { type: 'exported'; format: 'svg' | 'png'; data: string }
  /** Drawing a diagram, or an export, failed. */
  | { type: 'failed'; during: 'show' | 'export'; message: string };
