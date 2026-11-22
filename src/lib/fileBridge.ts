// Chunked byte access to a SAF file, on top of the native LibraryFolder
// plugin's getSize()/readChunk() (see LibraryFolderPlugin.kt). Replaces the
// old whole-file Base64 `readFile`: the bridge only ever carries one small
// slice at a time, and the bytes land directly in a Uint8Array.
//
// Everything here runs on the main thread - Capacitor plugin calls are
// main-thread only. The resulting Uint8Array can be transferred to a worker.

import { getFileSize, readChunkBase64 } from './libraryFolder';

const MIB = 1024 * 1024;

/**
 * Default size of one bridge call. 1 MiB: large enough that the fixed
 * per-call cost (opening a descriptor, one bridge round trip, one JSON
 * message) is amortized to a small fraction of the transfer, small enough
 * that each slice (plus its ~1.33x Base64 string) is a short-lived,
 * easily-collected allocation and a cancelled read stops within ~1 MiB.
 * Tune on a real phone; it is deliberately a constant, not a setting.
 */
export const DEFAULT_CHUNK_BYTES = 1 * MIB;

/** Mirrors MAX_CHUNK_BYTES in LibraryFolderPlugin.kt - the native hard ceiling for one call. */
export const NATIVE_MAX_CHUNK_BYTES = 4 * MIB;

/**
 * Sanity ceiling on the size of a book Vach will try to open: 150 MiB.
 *
 * Not a hard technical limit of the chunked bridge (which can read any
 * size); a guard so an oversized file fails with a clear message instead of
 * getting the WebView's renderer process killed by the OS, which would take
 * the app and the reader's position with it:
 *   - Memory for an opened book is about 1x its size (a Uint8Array for an
 *     EPUB; pdf.js's full-length chunk buffer in its worker for a PDF),
 *     plus working memory, on phones that commonly have 4-6 GB of RAM shared
 *     with every other app.
 *   - 150 MiB is ~1.5x the largest books in the owner's library (about
 *     100 MB), so every real book opens with headroom, while keeping the
 *     worst-case footprint modest on low-memory phones.
 * Raise it only with measurements from a real phone.
 */
export const MAX_BOOK_BYTES = 150 * MIB;

export class FileTooLargeError extends Error {
  readonly size: number;
  constructor(size: number) {
    super(
      `This file is ${formatMiB(size, Math.ceil)}, which is over the ${formatMiB(MAX_BOOK_BYTES)} limit Vach can safely open.`,
    );
    this.name = 'FileTooLargeError';
    this.size = size;
  }
}

// `round` is Math.ceil for the file's own size so a file just over the limit
// reads "151 MB", not the same number as the limit it exceeds.
function formatMiB(bytes: number, round: (n: number) => number = Math.round): string {
  return `${round(bytes / MIB).toLocaleString('en-US')} MB`;
}

/** The two native calls this module needs; injectable so tests need no Capacitor runtime. */
export interface ChunkTransport {
  getSize(uri: string): Promise<number>;
  readChunk(uri: string, offset: number, length: number): Promise<{ base64: string; length?: number }>;
}

export const defaultTransport: ChunkTransport = {
  getSize: getFileSize,
  readChunk: readChunkBase64,
};

export interface ReadOptions {
  transport?: ChunkTransport;
  /** Bytes requested per bridge call (clamped to 1..NATIVE_MAX_CHUNK_BYTES). */
  chunkBytes?: number;
  /** Checked before every chunk; aborting rejects with the signal's reason. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Base64 decoding
// ---------------------------------------------------------------------------

type FromBase64 = (base64: string) => Uint8Array;

/**
 * Decodes `base64` straight into `out` starting at `at`, returning the
 * number of bytes written. Uses the platform's native Uint8Array.fromBase64
 * when it exists (no intermediate binary string), otherwise atob() plus one
 * tight loop that writes into `out` directly - no intermediate Uint8Array
 * and no per-byte array growth. Feature detection is per call so the choice
 * follows the real WebView, not build-time assumptions.
 *
 * Throws RangeError if the decoded bytes wouldn't fit in `out`.
 */
export function decodeBase64Into(base64: string, out: Uint8Array, at = 0): number {
  const native = (Uint8Array as unknown as { fromBase64?: FromBase64 }).fromBase64;
  if (typeof native === 'function') {
    const bytes = native.call(Uint8Array, base64);
    if (at + bytes.length > out.length) throw new RangeError('Decoded data does not fit in the target buffer');
    out.set(bytes, at);
    return bytes.length;
  }

  const binary = atob(base64);
  const length = binary.length;
  if (at + length > out.length) throw new RangeError('Decoded data does not fit in the target buffer');
  for (let i = 0; i < length; i++) {
    out[at + i] = binary.charCodeAt(i);
  }
  return length;
}

/** Convenience: decode into a fresh, exactly-sized Uint8Array. */
export function decodeBase64(base64: string): Uint8Array {
  // 3 bytes per 4 chars is an upper bound (padding only ever shrinks it); trim afterwards.
  const out = new Uint8Array(Math.ceil((base64.length * 3) / 4));
  const written = decodeBase64Into(base64, out, 0);
  return written === out.length ? out : out.slice(0, written);
}

// ---------------------------------------------------------------------------
// Range / whole-file reads
// ---------------------------------------------------------------------------

function assertSafeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer (got ${value})`);
  }
}

function effectiveChunkBytes(requested: number | undefined): number {
  const wanted = requested ?? DEFAULT_CHUNK_BYTES;
  return Math.min(NATIVE_MAX_CHUNK_BYTES, Math.max(1, Math.floor(wanted)));
}

/** Size of the file in bytes. Does not apply the MAX_BOOK_BYTES ceiling. */
export async function getSize(uri: string, transport: ChunkTransport = defaultTransport): Promise<number> {
  const size = await transport.getSize(uri);
  assertSafeNonNegativeInteger(size, 'File size');
  return size;
}

/**
 * Reads `[offset, offset + length)` of the file as one Uint8Array, issuing
 * as many bridge calls as needed (each at most `chunkBytes`). If the range
 * runs past the end of the file the result is shorter than `length` (empty
 * if `offset` is at or past the end), exactly like a normal file read.
 */
export async function readRange(
  uri: string,
  offset: number,
  length: number,
  options: ReadOptions = {},
): Promise<Uint8Array> {
  assertSafeNonNegativeInteger(offset, 'offset');
  assertSafeNonNegativeInteger(length, 'length');
  if (length > MAX_BOOK_BYTES) throw new FileTooLargeError(length);
  if (length === 0) return new Uint8Array(0);

  const transport = options.transport ?? defaultTransport;
  const chunkBytes = effectiveChunkBytes(options.chunkBytes);
  const out = new Uint8Array(length);

  const filled = await fillFrom(uri, offset, out, transport, chunkBytes, options.signal);
  // A short result means end of file was reached; hand back just what exists.
  return filled === length ? out : out.subarray(0, filled);
}

/**
 * Fills `out` from the file starting at `offset`, chunk by chunk. Returns
 * the number of bytes actually written (less than out.length only at EOF).
 */
async function fillFrom(
  uri: string,
  offset: number,
  out: Uint8Array,
  transport: ChunkTransport,
  chunkBytes: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  let filled = 0;
  while (filled < out.length) {
    signal?.throwIfAborted();
    const want = Math.min(chunkBytes, out.length - filled);
    const chunk = await transport.readChunk(uri, offset + filled, want);
    const got = decodeBase64Into(chunk.base64, out, filled);
    if (got > want) {
      // decodeBase64Into already refused anything that overflows `out`, but
      // a chunk bigger than asked for would silently overwrite the next
      // chunk's slot - never trust the native side to have honored `want`.
      throw new Error(`Bridge returned ${got} bytes for a ${want}-byte request`);
    }
    filled += got;
    if (got < want) break; // end of file
  }
  return filled;
}

/**
 * Reads the whole file into one preallocated Uint8Array of exactly
 * getSize() bytes, filled chunk by chunk - so peak memory is the file's own
 * size plus one chunk, not several full-size copies. Throws
 * FileTooLargeError above MAX_BOOK_BYTES and a plain Error if the file
 * turns out shorter than its reported size (changed or truncated while
 * reading).
 */
export async function readAll(uri: string, options: ReadOptions = {}): Promise<Uint8Array> {
  const transport = options.transport ?? defaultTransport;
  const size = await getSize(uri, transport);
  if (size > MAX_BOOK_BYTES) throw new FileTooLargeError(size);
  if (size === 0) throw new Error('This file is empty');

  const out = new Uint8Array(size);
  const filled = await fillFrom(uri, 0, out, transport, effectiveChunkBytes(options.chunkBytes), options.signal);
  if (filled !== size) {
    throw new Error(`The file changed while it was being read (expected ${size} bytes, got ${filled})`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// A size + random-access reader, for consumers (pdf.js) that pull ranges
// ---------------------------------------------------------------------------

export interface FileSource {
  /** File size in bytes (already checked against MAX_BOOK_BYTES). */
  size: number;
  /** Reads [begin, end) - `end` exclusive, clamped to the file size. */
  read(begin: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** Looks up the file's size (enforcing MAX_BOOK_BYTES) and returns a range reader for it. */
export async function createFileSource(uri: string, options: ReadOptions = {}): Promise<FileSource> {
  const transport = options.transport ?? defaultTransport;
  const size = await getSize(uri, transport);
  if (size > MAX_BOOK_BYTES) throw new FileTooLargeError(size);
  if (size === 0) throw new Error('This file is empty');

  return {
    size,
    read: (begin, end, signal) => {
      const clampedEnd = Math.min(end, size);
      return readRange(uri, begin, Math.max(0, clampedEnd - begin), { ...options, transport, signal: signal ?? options.signal });
    },
  };
}
