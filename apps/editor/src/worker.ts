import './elk-shim.js';
import { compileSource, type Language } from './compile.js';

// Compiles off the main thread (FR-41), so typing never waits for layout.
self.onmessage = async (
  event: MessageEvent<{ id: number; source: string; language: Language }>,
) => {
  const { id, source, language } = event.data;
  self.postMessage({ id, ...(await compileSource(source, language)) });
};
