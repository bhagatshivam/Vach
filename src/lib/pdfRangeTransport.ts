// Feeds pdf.js through a PDFDataRangeTransport backed by the chunked file
// bridge (fileBridge.ts), instead of handing it the whole file as one
// in-memory Uint8Array. pdf.js asks for byte ranges as it needs them (the
// xref at the end of the file first, then objects for the pages in use), and
// each is answered by a few small native reads - no whole-file Base64 string
// ever exists.
//
// Honest limits: pdf.js still allocates a full-length buffer for the document
// inside its worker, and this app's text pass currently visits every page, so
// memory ends up about 1x the file size (not flat) - see the blueprint's
// amendment A1. What this removes is the 6-8x multiplier and the old size cap.

import { PDFDataRangeTransport } from 'pdfjs-dist/legacy/build/pdf.mjs';

const MIB = 1024 * 1024;

/**
 * pdf.js `rangeChunkSize`: the granularity it requests and caches bytes at.
 * 1 MiB matches the bridge's own default chunk, so one pdf.js chunk is one
 * native call. (pdf.js's default is 64 KiB, which would mean ~16x more
 * bridge round trips for the same bytes.) Ranges pdf.js requests are always
 * multiples of this, except the final one, which ends at the file's end.
 */
export const PDF_RANGE_CHUNK_BYTES = 1 * MIB;

/**
 * How much of the file is handed to pdf.js up front as `initialData`. pdf.js
 * treats this as the start of the progressive download, so the header is
 * available without a range round trip. Must not exceed the file size.
 */
export const PDF_INITIAL_BYTES = 1 * MIB;

export type RangeReader = (begin: number, end: number, signal?: AbortSignal) => Promise<Uint8Array>;

export class BridgeRangeTransport extends PDFDataRangeTransport {
  /** Set once a bridge read fails; pdf.js has no error channel for range requests, so callers check this. */
  fatalError: Error | null = null;
  /** Called (once) when a bridge read fails, so the owner can tear the document down instead of letting pdf.js wait forever. */
  onFatal: ((error: Error) => void) | null = null;

  readonly #read: RangeReader;
  readonly #abortController = new AbortController();

  constructor(length: number, initialData: Uint8Array | null, progressiveDone: boolean, read: RangeReader) {
    super(length, initialData, progressiveDone);
    this.#read = read;
  }

  requestDataRange(begin: number, end: number): void {
    const signal = this.#abortController.signal;
    if (signal.aborted) return;

    this.#read(begin, end, signal).then(
      (chunk) => {
        if (signal.aborted) return;
        // pdf.js clamps `end` to the real file length, so a short result
        // means the file changed under us. Handing pdf.js a truncated chunk
        // would crash its chunk bookkeeping deep inside the worker.
        if (chunk.length !== end - begin) {
          this.#fail(new Error(`The file changed while it was being read (expected ${end - begin} bytes at ${begin}, got ${chunk.length})`));
          return;
        }
        this.onDataRange(begin, chunk);
      },
      (error: unknown) => {
        if (signal.aborted) return;
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  /** pdf.js calls this when the document is destroyed or its requests are cancelled. */
  abort(): void {
    this.#abortController.abort();
  }

  #fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    this.#abortController.abort();
    this.onFatal?.(error);
  }
}
