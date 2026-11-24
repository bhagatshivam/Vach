// Opens an EPUB from a SAF file, choosing how to read it by size:
//
//   - up to EPUB_WHOLE_FILE_MAX_BYTES: read the whole file once (readAll,
//     one pass of 1 MiB bridge calls straight into a preallocated buffer) and
//     hand it to JSZip - exactly what the reader did before. For the typical
//     book (KBs to a few MB) that is the fastest way: a handful of native
//     calls, then everything is in memory.
//   - above it: don't read the whole file. Read the ZIP's central directory
//     from the tail and fetch only the entries asked for (zipReader.ts), so
//     opening a big, image-heavy EPUB costs a couple of small reads instead of
//     the whole file, and memory isn't proportional to the file size.
//
// Both paths produce the same EpubBook (see epub.ts), so what the reader
// shows doesn't depend on which one ran.

import JSZip from 'jszip';
import { archiveFromJSZip, openEpub, type EpubBook } from './epub';
import { createFileSource, readAll, type ReadOptions } from './fileBridge';
import { openZip } from './zipReader';

const MIB = 1024 * 1024;

/**
 * Largest EPUB that is read whole. 16 MiB:
 *   - Reading 16 MiB is 16 bridge calls, and a typical book (KBs to a few
 *     MB, even with a cover and some art) is 1-5 of them. Per-entry reads
 *     would be hundreds of calls for a 1,000-chapter book, so below this one
 *     pass wins.
 *   - Holding the file in memory is cheap at this size (16 MiB is a few
 *     percent of a WebView's budget), and JSZip - the path every existing
 *     book has used - stays the code that opens ordinary books.
 *   - Above it, a whole-file read stops being cheap (more calls, and memory
 *     proportional to the file), and the ranged path pays only for what is
 *     read.
 * This is a starting point, not a measured optimum - tune it on the phone.
 */
export const EPUB_WHOLE_FILE_MAX_BYTES = 16 * MIB;

export interface OpenEpubFileOptions extends ReadOptions {
  /** Override EPUB_WHOLE_FILE_MAX_BYTES (tests). */
  wholeFileMaxBytes?: number;
}

export async function openEpubFile(
  uri: string,
  fallbackTitle: string,
  options: OpenEpubFileOptions = {},
): Promise<EpubBook> {
  // Looks up the size and enforces the book-size ceiling and the empty-file check.
  const source = await createFileSource(uri, options);
  const wholeFileMax = options.wholeFileMaxBytes ?? EPUB_WHOLE_FILE_MAX_BYTES;

  if (source.size <= wholeFileMax) {
    const bytes = await readAll(uri, { ...options, knownSize: source.size });
    const zip = await JSZip.loadAsync(bytes);
    return openEpub(archiveFromJSZip(zip), fallbackTitle);
  }

  const archive = await openZip({
    size: source.size,
    read: (begin, end) => source.read(begin, end, options.signal),
  });
  return openEpub(
    {
      has: (path) => archive.has(path),
      read: (path, maxBytes) => archive.read(path, maxBytes),
      // Sizes come from the central directory that was already read to open the archive.
      sizeOf: (path) => archive.entries.get(path)?.uncompressedSize,
    },
    fallbackTitle,
  );
}
