import { describe, expect, it, vi } from 'vitest';
import { openDocxFile } from './docxFile';
import { DocxError } from './docxError';
import { MAX_BOOK_BYTES, FileTooLargeError, type ChunkTransport } from './fileBridge';
import type { DocxConversion } from './docxTypes';

// A document read through the chunked bridge: the bytes the converter receives are exactly the file's.

function transportOver(bytes: Uint8Array) {
  const reads: Array<[number, number]> = [];
  const transport: ChunkTransport = {
    getSize: async () => bytes.length,
    readChunk: async (_uri, offset, length) => {
      reads.push([offset, offset + length]);
      const slice = bytes.subarray(offset, offset + length);
      return { base64: Buffer.from(slice).toString('base64'), length: slice.length };
    },
  };
  return { transport, reads };
}

const conversion: DocxConversion = { html: '<h1>Hello</h1><p>world</p>', images: [], title: 'Hello', warnings: [] };

describe('openDocxFile', () => {
  it('reads the whole file through the bridge and hands those bytes to the converter', async () => {
    const bytes = Uint8Array.from({ length: 3 * 1024 * 1024 + 17 }, (_, i) => i % 251);
    const { transport, reads } = transportOver(bytes);
    const convert = vi.fn(async (buffer: ArrayBuffer) => {
      expect(buffer.byteLength).toBe(bytes.length);
      expect(Buffer.from(buffer).equals(Buffer.from(bytes))).toBe(true);
      return conversion;
    });
    const book = await openDocxFile('content://x/doc.docx', 'doc', { transport, convert });
    expect(convert).toHaveBeenCalledTimes(1);
    expect(book.title).toBe('Hello');
    expect(book.chapterCount).toBe(1);
    expect(reads.length).toBeGreaterThanOrEqual(3); // 1 MiB chunks
    for (const [, end] of reads) expect(end).toBeLessThanOrEqual(bytes.length);
  });

  it('a zero-byte file is a damaged document, with the readable message', async () => {
    const { transport } = transportOver(new Uint8Array(0));
    const error = await openDocxFile('content://x/a.docx', 'a', { transport, convert: async () => conversion }).catch((e) => e);
    expect(error).toBeInstanceOf(DocxError);
    expect(error.code).toBe('corrupt');
  });

  it('a file over the book-size ceiling is refused before anything is read', async () => {
    const reads: number[] = [];
    const transport: ChunkTransport = { getSize: async () => MAX_BOOK_BYTES + 1, readChunk: async (_u, o) => (reads.push(o), { base64: '', length: 0 }) };
    await expect(openDocxFile('content://x/a.docx', 'a', { transport, convert: async () => conversion })).rejects.toBeInstanceOf(FileTooLargeError);
    expect(reads).toEqual([]);
  });

  it("a converter's DocxError reaches the reader as it is", async () => {
    const { transport } = transportOver(new Uint8Array([1, 2, 3]));
    const error = await openDocxFile('content://x/a.docx', 'a', { transport, convert: async () => Promise.reject(new DocxError('password-protected')) }).catch((e) => e);
    expect(error).toBeInstanceOf(DocxError);
    expect(error.message).toMatch(/password/);
  });

  it('is cancelled by the abort signal, passing it on to the converter', async () => {
    const { transport } = transportOver(new Uint8Array([1, 2, 3]));
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    await openDocxFile('content://x/a.docx', 'a', { transport, signal: controller.signal, convert: async (_b, signal) => (seen.push(signal), conversion) });
    expect(seen[0]).toBe(controller.signal);
  });
});
