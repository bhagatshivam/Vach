// Stands in for src/lib/libraryFolder.ts inside the frame check: a library that is empty or holds a few books,
// chosen by window.__libraryMode, with no native plugin.
import type { LibraryFile } from '../../src/lib/libraryFolder';

const files: LibraryFile[] = ['The Long Road.epub', 'Notes on Water.pdf', 'Field Guide.epub'].map((name) => ({ name, uri: `content://x/${name}`, path: name, size: 1000 }));

export async function scanAllSources() {
  const books = (window as unknown as { __libraryMode?: string }).__libraryMode === 'books';
  return {
    sources: books ? [{ source: { type: 'folder' as const, uri: 'content://x' }, displayName: 'Books' }] : [],
    files: books ? files : [],
    failedSources: [],
  };
}
export async function addFolderSource() {}
export async function addFileSources() {}
export async function removeSource() {}
export async function getFileSize(): Promise<number> {
  throw new Error('not available in the frame check');
}
export async function readChunkBase64(): Promise<never> {
  throw new Error('not available in the frame check');
}
