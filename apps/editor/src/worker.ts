import './elk-shim.js';
import { compileSource } from './compile.js';

// Compiles off the main thread (FR-41), so typing never waits for layout.
self.onmessage = async (
  event: MessageEvent<{ id: number; source: string }>,
) => {
  const { id, source } = event.data;
  self.postMessage({ id, ...(await compileSource(source)) });
};
