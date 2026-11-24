/** Messages from the extension to the preview webview. */
export type ToWebview =
  | { type: 'show'; xml: string }
  | { type: 'highlight'; id: string | undefined }
  | { type: 'export'; format: 'svg' | 'png' };

/** Messages from the preview webview to the extension. */
export type FromWebview =
  | { type: 'shown' }
  | { type: 'select'; id: string }
  /** `data` is SVG text, or a PNG as base64. */
  | { type: 'exported'; format: 'svg' | 'png'; data: string }
  | { type: 'failed'; message: string };
