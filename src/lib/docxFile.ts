// Opens a Word document from a SAF file: reads the bytes through the chunked bridge (a .docx is small, so the whole
// file at once), converts them in a Worker, and returns the book. Dynamically imported by the reader, so none of it -
// nor mammoth - is loaded until a .docx is opened.

import type { EpubBook } from './epub';
import { readAll, type ReadOptions } from './fileBridge';
import { openDocx } from './docx';
import { convertDocxBytes, type DocxConverter } from './docxClient';
import { DocxError } from './docxError';

export interface OpenDocxFileOptions extends ReadOptions {
  /** Override the converter (tests). */
  convert?: DocxConverter;
}

export async function openDocxFile(uri: string, fallbackTitle: string, options: OpenDocxFileOptions = {}): Promise<EpubBook> {
  let bytes: Uint8Array;
  try {
    bytes = await readAll(uri, options);
  } catch (err) {
    // A zero-byte file is a damaged document, not an I/O failure.
    if (err instanceof Error && err.message === 'This file is empty') throw new DocxError('corrupt');
    throw err;
  }
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
  return openDocx(buffer, fallbackTitle, { convert: options.convert ?? convertDocxBytes, signal: options.signal });
}
