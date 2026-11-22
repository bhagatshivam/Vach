// A small, DOM-free ZIP reader that works from byte ranges instead of a whole
// in-memory archive: it reads the end-of-central-directory record from the
// tail of the file, parses the central directory into an entry index, and then
// reads and inflates single entries on demand. This is what lets a large EPUB
// open without ever holding the whole file in memory or reading every byte.
//
// Scope, deliberately narrow (it only has to read EPUBs):
//   - stored (0) and deflate (8) entries; any other method is a clear error
//   - no ZIP64 (a clear error if the archive uses it), no multi-disk archives
//   - no encryption (a clear error)
//   - no CRC check (JSZip, used for small EPUBs, doesn't check it by default
//     either; entry sizes come from the central directory)
//
// Inflating uses the platform's DecompressionStream('deflate-raw'): zero bytes
// of bundle, runs off the main thread, fully offline. See the PR notes for
// why that was chosen over fflate.

export interface ZipEntry {
  /** Decoded entry name, exactly as stored (case-sensitive, '/'-separated). */
  name: string;
  /** Compression method: 0 = stored, 8 = deflate. Anything else fails on read. */
  method: number;
  /** General purpose bit flags (bit 0 = encrypted, bit 3 = data descriptor, bit 11 = UTF-8 names). */
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the entry's local file header from the start of the file. */
  localHeaderOffset: number;
  /** Byte length of the name field in the central directory (and, normally, the local header). */
  nameLength: number;
}

/** A random-access view of a file: its size and a reader for [begin, end). */
export interface ZipByteSource {
  size: number;
  read(begin: number, end: number): Promise<Uint8Array>;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const EOCD_FIXED_BYTES = 22;
const ZIP64_LOCATOR_BYTES = 20;
const MAX_COMMENT_BYTES = 0xffff;
const CENTRAL_FIXED_BYTES = 46;
const LOCAL_FIXED_BYTES = 30;

/**
 * Extra bytes read past the end of a name field when fetching an entry, so
 * the local header's own (usually tiny) extra field normally arrives in the
 * same read as the data. If a local extra field is bigger than this the data
 * is simply fetched with one more read.
 */
const LOCAL_EXTRA_SLACK_BYTES = 512;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;

const MIB = 1024 * 1024;

export const DEFAULT_BLOCK_BYTES = 1 * MIB;
export const DEFAULT_MAX_CACHED_BLOCKS = 8;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  // >>> 0 keeps the result an unsigned number (bit ops are signed 32-bit).
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

const ZIP64_MESSAGE = 'This EPUB uses the ZIP64 format, which Vach does not support yet';

// ---------------------------------------------------------------------------
// End of central directory
// ---------------------------------------------------------------------------

export interface EndOfCentralDirectory {
  /** Number of entries in the central directory. */
  entryCount: number;
  /** Size in bytes of the central directory. */
  centralDirectorySize: number;
  /** Offset of the central directory from the start of the file. */
  centralDirectoryOffset: number;
  /** Offset of the EOCD record within the buffer that was searched. */
  position: number;
}

/**
 * Finds and parses the EOCD record in `tail` (the last bytes of the file).
 * Searches backwards, so a trailing archive comment - up to 64 KiB, and
 * allowed to contain anything, even the EOCD signature - is handled: a
 * candidate is only accepted if its own comment-length field exactly
 * accounts for the bytes after it. A second, lenient pass accepts trailing
 * junk after the comment.
 */
export function parseEndOfCentralDirectory(tail: Uint8Array): EndOfCentralDirectory {
  if (tail.length < EOCD_FIXED_BYTES) {
    throw new ZipFormatError('Not a valid ZIP archive: the file is too small');
  }

  const lastStart = tail.length - EOCD_FIXED_BYTES;
  const firstStart = Math.max(0, tail.length - EOCD_FIXED_BYTES - MAX_COMMENT_BYTES);

  let found = -1;
  for (const strict of [true, false]) {
    for (let pos = lastStart; pos >= firstStart; pos--) {
      if (u32(tail, pos) !== SIG_EOCD) continue;
      const end = pos + EOCD_FIXED_BYTES + u16(tail, pos + 20);
      if (strict ? end === tail.length : end <= tail.length) {
        found = pos;
        break;
      }
    }
    if (found !== -1) break;
  }
  if (found === -1) {
    throw new ZipFormatError('Not a valid ZIP archive: no end-of-central-directory record found');
  }

  const diskNumber = u16(tail, found + 4);
  const centralDirectoryDisk = u16(tail, found + 6);
  const entriesOnDisk = u16(tail, found + 8);
  const entryCount = u16(tail, found + 10);
  const centralDirectorySize = u32(tail, found + 12);
  const centralDirectoryOffset = u32(tail, found + 16);

  // A ZIP64 locator sits immediately before the EOCD, and a ZIP64 archive
  // stores 0xFFFF / 0xFFFFFFFF placeholders in the classic fields.
  const hasLocator = found >= ZIP64_LOCATOR_BYTES && u32(tail, found - ZIP64_LOCATOR_BYTES) === SIG_ZIP64_LOCATOR;
  if (
    hasLocator ||
    entryCount === 0xffff ||
    entriesOnDisk === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new ZipFormatError(ZIP64_MESSAGE);
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new ZipFormatError('Multi-part ZIP archives are not supported');
  }

  return { entryCount, centralDirectorySize, centralDirectoryOffset, position: found };
}

// ---------------------------------------------------------------------------
// Central directory
// ---------------------------------------------------------------------------

function decodeName(raw: Uint8Array, flags: number): string {
  if (flags & FLAG_UTF8) return new TextDecoder().decode(raw);
  // No UTF-8 flag: the ZIP spec says CP437, but EPUB requires UTF-8 names and
  // plenty of tools write UTF-8 bytes without setting the flag. Use UTF-8 when
  // the bytes are valid UTF-8 (pure ASCII always is), otherwise fall back to
  // one-char-per-byte so the entry is still addressable.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    let out = '';
    for (const byte of raw) out += String.fromCharCode(byte);
    return out;
  }
}

/** Parses `entryCount` central directory records out of `bytes`. Directory entries (names ending in '/') are skipped. */
export function parseCentralDirectory(bytes: Uint8Array, entryCount: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let at = 0;

  for (let i = 0; i < entryCount; i++) {
    if (at + CENTRAL_FIXED_BYTES > bytes.length || u32(bytes, at) !== SIG_CENTRAL) {
      throw new ZipFormatError('This EPUB looks corrupt: its file index is damaged');
    }
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const compressedSize = u32(bytes, at + 20);
    const uncompressedSize = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const localHeaderOffset = u32(bytes, at + 42);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ZipFormatError(ZIP64_MESSAGE);
    }

    const nameStart = at + CENTRAL_FIXED_BYTES;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > bytes.length) {
      throw new ZipFormatError('This EPUB looks corrupt: its file index is cut short');
    }

    const name = decodeName(bytes.subarray(nameStart, nameStart + nameLength), flags);
    if (!name.endsWith('/')) {
      entries.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset, nameLength });
    }
    at = next;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Inflate
// ---------------------------------------------------------------------------

function capError(name: string, maxBytes: number): Error {
  // Same wording as the JSZip-backed path in epub.ts, so both fail alike.
  return new Error(`Entry "${name}" exceeds the ${maxBytes}-byte decompressed-size cap`);
}

/**
 * Inflates one raw-deflate stream, counting the bytes that actually come out
 * and aborting the moment `maxBytes` is crossed. The cap is on real output,
 * not on the size the archive claims, because a header is just a field
 * written by whoever made the file - a zip bomb can lie about it.
 */
async function inflateRaw(data: Uint8Array, maxBytes: number, name: string): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      "This device's WebView is too old to unpack large EPUBs. Update Android System WebView and try again.",
    );
  }

  // DecompressionStream's writable side is typed as accepting BufferSource
  // (ArrayBuffer-backed views only), hence the narrower element type.
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(data as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  });
  const reader = input.pipeThrough(new DecompressionStream('deflate-raw')).getReader();

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw capError(name, maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (total > maxBytes) throw error;
    throw new ZipFormatError(`This EPUB looks corrupt: "${name}" could not be decompressed`);
  }

  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block cache over a byte source
// ---------------------------------------------------------------------------

/**
 * Wraps a byte source so reads of up to one block are served from aligned,
 * cached blocks. Chapters of an EPUB are small and usually stored one after
 * another, so reading the next chapter is normally a cache hit instead of
 * another trip across the native bridge. Reads bigger than a block (large
 * images) go straight to the source.
 */
function withBlockCache(source: ZipByteSource, blockBytes: number, maxBlocks: number): ZipByteSource {
  const blocks = new Map<number, Promise<Uint8Array>>(); // insertion order = LRU order

  function block(index: number): Promise<Uint8Array> {
    const cached = blocks.get(index);
    if (cached) {
      blocks.delete(index); // re-insert as most recently used
      blocks.set(index, cached);
      return cached;
    }
    const start = index * blockBytes;
    const pending = source.read(start, Math.min(start + blockBytes, source.size));
    blocks.set(index, pending);
    pending.catch(() => {
      if (blocks.get(index) === pending) blocks.delete(index);
    });
    while (blocks.size > maxBlocks) {
      blocks.delete(blocks.keys().next().value as number);
    }
    return pending;
  }

  return {
    size: source.size,
    async read(begin, end) {
      const length = end - begin;
      if (length <= 0) return new Uint8Array(0);
      if (length > blockBytes) return source.read(begin, end);

      const firstBlock = Math.floor(begin / blockBytes);
      const lastBlock = Math.floor((end - 1) / blockBytes);
      if (firstBlock === lastBlock) {
        const data = await block(firstBlock);
        const from = begin - firstBlock * blockBytes;
        return data.subarray(from, from + length);
      }

      const [a, b] = await Promise.all([block(firstBlock), block(lastBlock)]);
      const out = new Uint8Array(length);
      const from = begin - firstBlock * blockBytes;
      out.set(a.subarray(from), 0);
      out.set(b.subarray(0, length - (a.length - from)), a.length - from);
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

export interface ZipArchive {
  readonly entries: ReadonlyMap<string, ZipEntry>;
  /** True if there is a (non-directory) entry with exactly this name. */
  has(name: string): boolean;
  /**
   * Reads and, if needed, inflates one entry. Rejects if it doesn't exist,
   * uses an unsupported method, or would produce more than `maxBytes`.
   */
  read(name: string, maxBytes: number): Promise<Uint8Array>;
}

export interface OpenZipOptions {
  blockBytes?: number;
  maxCachedBlocks?: number;
}

/**
 * Opens a ZIP from byte ranges: one read for the tail (EOCD), one for the
 * central directory (reusing the tail if it already covers it). No entry
 * data is read until `read()` is called.
 */
export async function openZip(source: ZipByteSource, options: OpenZipOptions = {}): Promise<ZipArchive> {
  const tailLength = Math.min(source.size, EOCD_FIXED_BYTES + ZIP64_LOCATOR_BYTES + MAX_COMMENT_BYTES);
  const tailStart = source.size - tailLength;
  const tail = await source.read(tailStart, source.size);
  const eocd = parseEndOfCentralDirectory(tail);

  const eocdAbsolute = tailStart + eocd.position;
  const cdStart = eocd.centralDirectoryOffset;
  const cdEnd = cdStart + eocd.centralDirectorySize;
  if (cdEnd > eocdAbsolute) {
    throw new ZipFormatError('This EPUB looks corrupt: its file index points outside the file');
  }

  const cdBytes =
    cdStart >= tailStart ? tail.subarray(cdStart - tailStart, cdEnd - tailStart) : await source.read(cdStart, cdEnd);
  const entryList = parseCentralDirectory(cdBytes, eocd.entryCount);

  const entries = new Map<string, ZipEntry>();
  for (const entry of entryList) entries.set(entry.name, entry);

  const cached = withBlockCache(source, options.blockBytes ?? DEFAULT_BLOCK_BYTES, options.maxCachedBlocks ?? DEFAULT_MAX_CACHED_BLOCKS);

  /** The entry's stored (still compressed) bytes, located via its local header. */
  async function readRaw(entry: ZipEntry): Promise<Uint8Array> {
    const begin = entry.localHeaderOffset;
    if (begin + LOCAL_FIXED_BYTES > source.size) {
      throw new ZipFormatError(`This EPUB looks corrupt: "${entry.name}" points outside the file`);
    }

    const guessedEnd = Math.min(
      source.size,
      begin + LOCAL_FIXED_BYTES + entry.nameLength + LOCAL_EXTRA_SLACK_BYTES + entry.compressedSize,
    );
    const head = await cached.read(begin, guessedEnd);
    if (head.length < LOCAL_FIXED_BYTES || u32(head, 0) !== SIG_LOCAL) {
      throw new ZipFormatError(`This EPUB looks corrupt: "${entry.name}" has a damaged file header`);
    }

    // The local header's name/extra lengths are what locate the data; they
    // can differ from the central directory's, so read them rather than guess.
    const dataOffset = LOCAL_FIXED_BYTES + u16(head, 26) + u16(head, 28);
    const dataEnd = dataOffset + entry.compressedSize;
    if (begin + dataEnd > source.size) {
      throw new ZipFormatError(`This EPUB looks corrupt: "${entry.name}" is cut short (the file is truncated)`);
    }
    if (dataEnd <= head.length) return head.subarray(dataOffset, dataEnd);

    const rest = await cached.read(begin + Math.max(dataOffset, head.length), begin + dataEnd);
    if (dataOffset >= head.length) return rest;
    const out = new Uint8Array(entry.compressedSize);
    out.set(head.subarray(dataOffset), 0);
    out.set(rest, head.length - dataOffset);
    return out;
  }

  return {
    entries,
    has: (name) => entries.has(name),
    async read(name, maxBytes) {
      const entry = entries.get(name);
      if (!entry) throw new Error(`Entry "${name}" not found in the archive`);
      if (entry.flags & FLAG_ENCRYPTED) {
        throw new ZipFormatError(`"${name}" is encrypted, which Vach does not support`);
      }
      if (entry.method !== 0 && entry.method !== 8) {
        throw new ZipFormatError(
          `Unsupported ZIP compression method ${entry.method} for "${name}" (only stored and deflate are supported)`,
        );
      }
      // Stored entries are their own output, so the size check needs no read.
      if (entry.method === 0 && entry.compressedSize > maxBytes) throw capError(name, maxBytes);

      if (entry.compressedSize === 0) return new Uint8Array(0);
      const raw = await readRaw(entry);
      return entry.method === 0 ? raw : inflateRaw(raw, maxBytes, name);
    },
  };
}
