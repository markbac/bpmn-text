import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from 'lz-string';

const PREFIX = '#src=';

/** A URL hash that holds `source`, compressed (FR-44). */
export function shareHash(source: string): string {
  return `${PREFIX}${compressToEncodedURIComponent(source)}`;
}

/** The source in a share-link hash, or undefined if there is none. */
export function sourceFromHash(hash: string): string | undefined {
  if (!hash.startsWith(PREFIX)) return undefined;
  return (
    decompressFromEncodedURIComponent(hash.slice(PREFIX.length)) ?? undefined
  );
}

/**
 * localStorage that may be missing or refuse access (private windows,
 * blocked site data): reads return undefined and writes do nothing.
 */
export const storage = {
  get(key: string): string | undefined {
    try {
      return localStorage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Not saved; the editor works without it.
    }
  },
};

/** A file name for downloads, from the `title` directive. */
export function fileName(source: string): string {
  const title = /^title\s+(?:"((?:[^"\\]|\\.)*)"|(.+))$/m.exec(source);
  const name = (title?.[1] ?? title?.[2] ?? 'diagram').trim();
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'diagram'
  );
}
