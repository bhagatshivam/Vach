import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHUNK_BYTES,
  FileTooLargeError,
  MAX_BOOK_BYTES,
  NATIVE_MAX_CHUNK_BYTES,
  createFileSource,
  decodeBase64,
  decodeBase64Into,
  getSize,
  readAll,
  readRange,
  type ChunkTransport,
} from './fileBridge';

// A fake native side: an in-memory "file" served in slices exactly the way
// LibraryFolderPlugin.readChunk does - Base64 of [offset, offset + length),
// clipped at end of file, empty at or past the end - and a record of every
// call so tests can assert chunk boundaries.
function makeFile(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

interface FakeBridge extends ChunkTransport {
  calls: Array<{ offset: number; length: number }>;
}

function fakeBridge(file: Uint8Array, overrides: Partial<ChunkTransport> = {}): FakeBridge {
  const calls: FakeBridge['calls'] = [];
  return {
    calls,
    getSize: async () => file.length,
    readChunk: async (_uri, offset, length) => {
      calls.push({ offset, length });
      const slice = file.subarray(Math.min(offset, file.length), Math.min(offset + length, file.length));
      return { base64: toBase64(slice), length: slice.length };
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64;
});

describe('decodeBase64 / decodeBase64Into', () => {
  it('decodes known vectors with 0, 1 and 2 padding characters', () => {
    expect(Array.from(decodeBase64('TWFu'))).toEqual([77, 97, 110]); // "Man", no padding
    expect(Array.from(decodeBase64('TWE='))).toEqual([77, 97]); // 1 padding
    expect(Array.from(decodeBase64('TQ=='))).toEqual([77]); // 2 padding
    expect(decodeBase64('')).toHaveLength(0);
  });

  it('round-trips every byte value', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(Array.from(decodeBase64(toBase64(all)))).toEqual(Array.from(all));
  });

  it('round-trips lengths around the 3-byte boundary', () => {
    for (const length of [1, 2, 3, 4, 5, 6, 7, 1023, 1024, 1025]) {
      const bytes = makeFile(length);
      expect(Array.from(decodeBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('writes at an offset in the target and returns the byte count, leaving the rest untouched', () => {
    const out = new Uint8Array(8).fill(9);
    const written = decodeBase64Into('TWFu', out, 2);
    expect(written).toBe(3);
    expect(Array.from(out)).toEqual([9, 9, 77, 97, 110, 9, 9, 9]);
  });

  it('refuses to write past the end of the target', () => {
    expect(() => decodeBase64Into('TWFu', new Uint8Array(2), 0)).toThrow(RangeError);
    expect(() => decodeBase64Into('TWFu', new Uint8Array(4), 2)).toThrow(RangeError);
  });

  it('uses the platform Uint8Array.fromBase64 when present, with identical results', () => {
    const fromBase64 = vi.fn((s: string) => new Uint8Array(Buffer.from(s, 'base64')));
    (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64 = fromBase64;
    const out = new Uint8Array(5).fill(1);
    expect(decodeBase64Into('TWFu', out, 1)).toBe(3);
    expect(fromBase64).toHaveBeenCalledOnce();
    expect(Array.from(out)).toEqual([1, 77, 97, 110, 1]);
    expect(() => decodeBase64Into('TWFu', new Uint8Array(2), 0)).toThrow(RangeError);
  });
});

describe('readRange - chunk assembly', () => {
  const CHUNK = 8;

  it('exact multiple of the chunk size: no extra empty call, nothing short', async () => {
    const file = makeFile(CHUNK * 3);
    const bridge = fakeBridge(file);
    const out = await readRange('u', 0, file.length, { transport: bridge, chunkBytes: CHUNK });
    expect(Array.from(out)).toEqual(Array.from(file));
    expect(bridge.calls).toEqual([
      { offset: 0, length: 8 },
      { offset: 8, length: 8 },
      { offset: 16, length: 8 },
    ]);
  });

  it('one byte over a multiple: a final 1-byte chunk', async () => {
    const file = makeFile(CHUNK * 2 + 1);
    const bridge = fakeBridge(file);
    const out = await readRange('u', 0, file.length, { transport: bridge, chunkBytes: CHUNK });
    expect(Array.from(out)).toEqual(Array.from(file));
    expect(bridge.calls.map((c) => c.length)).toEqual([8, 8, 1]);
  });

  it('one byte under a multiple: a final chunk of CHUNK-1', async () => {
    const file = makeFile(CHUNK * 3 - 1);
    const bridge = fakeBridge(file);
    const out = await readRange('u', 0, file.length, { transport: bridge, chunkBytes: CHUNK });
    expect(Array.from(out)).toEqual(Array.from(file));
    expect(bridge.calls.map((c) => c.length)).toEqual([8, 8, 7]);
  });

  it('a request smaller than one chunk is a single exact-size call', async () => {
    const file = makeFile(100);
    const bridge = fakeBridge(file);
    const out = await readRange('u', 10, 5, { transport: bridge, chunkBytes: CHUNK });
    expect(Array.from(out)).toEqual(Array.from(file.subarray(10, 15)));
    expect(bridge.calls).toEqual([{ offset: 10, length: 5 }]);
  });

  it('reads from a mid-file offset that is not chunk-aligned', async () => {
    const file = makeFile(100);
    const bridge = fakeBridge(file);
    const out = await readRange('u', 13, 30, { transport: bridge, chunkBytes: CHUNK });
    expect(Array.from(out)).toEqual(Array.from(file.subarray(13, 43)));
    expect(bridge.calls.map((c) => c.offset)).toEqual([13, 21, 29, 37]);
    expect(bridge.calls.map((c) => c.length)).toEqual([8, 8, 8, 6]);
  });

  it('a range that runs past the end of the file returns just the bytes that exist', async () => {
    const file = makeFile(20);
    const bridge = fakeBridge(file);
    const out = await readRange('u', 12, 100, { transport: bridge, chunkBytes: CHUNK });
    expect(Array.from(out)).toEqual(Array.from(file.subarray(12)));
    // 8 bytes, then a short 0..., stops at the first short chunk instead of reading on.
    expect(bridge.calls).toEqual([
      { offset: 12, length: 8 },
      { offset: 20, length: 8 },
    ]);
  });

  it('an offset at or past the end of the file returns an empty array', async () => {
    const file = makeFile(20);
    expect(await readRange('u', 20, 5, { transport: fakeBridge(file), chunkBytes: CHUNK })).toHaveLength(0);
    expect(await readRange('u', 500, 5, { transport: fakeBridge(file), chunkBytes: CHUNK })).toHaveLength(0);
  });

  it('length 0 returns an empty array without calling the bridge', async () => {
    const bridge = fakeBridge(makeFile(20));
    expect(await readRange('u', 5, 0, { transport: bridge })).toHaveLength(0);
    expect(bridge.calls).toHaveLength(0);
  });

  it('rejects negative, fractional and non-finite offsets and lengths', async () => {
    const bridge = fakeBridge(makeFile(20));
    for (const [offset, length] of [
      [-1, 5],
      [0, -1],
      [1.5, 5],
      [0, 2.5],
      [Number.NaN, 5],
      [0, Number.POSITIVE_INFINITY],
    ] as const) {
      await expect(readRange('u', offset, length, { transport: bridge })).rejects.toThrow(RangeError);
    }
    expect(bridge.calls).toHaveLength(0);
  });

  it('never asks the native side for more than its hard per-call maximum', async () => {
    const file = makeFile(NATIVE_MAX_CHUNK_BYTES + 10);
    const bridge = fakeBridge(file);
    await readRange('u', 0, file.length, { transport: bridge, chunkBytes: NATIVE_MAX_CHUNK_BYTES * 10 });
    expect(bridge.calls.map((c) => c.length)).toEqual([NATIVE_MAX_CHUNK_BYTES, 10]);
  });

  it('treats a non-positive chunk size as 1 byte rather than looping forever', async () => {
    const bridge = fakeBridge(makeFile(3));
    const out = await readRange('u', 0, 3, { transport: bridge, chunkBytes: 0 });
    expect(out).toHaveLength(3);
    expect(bridge.calls.map((c) => c.length)).toEqual([1, 1, 1]);
  });

  it('defaults to DEFAULT_CHUNK_BYTES per call', async () => {
    const file = makeFile(DEFAULT_CHUNK_BYTES + 5);
    const bridge = fakeBridge(file);
    await readRange('u', 0, file.length, { transport: bridge });
    expect(bridge.calls.map((c) => c.length)).toEqual([DEFAULT_CHUNK_BYTES, 5]);
  });

  it('throws if the native side returns more bytes than were asked for', async () => {
    const bridge = fakeBridge(makeFile(100), {
      readChunk: async () => ({ base64: toBase64(makeFile(50)), length: 50 }),
    });
    await expect(readRange('u', 0, 100, { transport: bridge, chunkBytes: 8 })).rejects.toThrow(/Bridge returned 50 bytes for a 8-byte request/);
  });

  it('stops before the next chunk once the signal is aborted', async () => {
    const controller = new AbortController();
    const file = makeFile(100);
    const bridge = fakeBridge(file);
    const original = bridge.readChunk;
    bridge.readChunk = async (...args) => {
      const result = await original(...args);
      if (bridge.calls.length === 2) controller.abort(new Error('stop'));
      return result;
    };
    await expect(readRange('u', 0, 100, { transport: bridge, chunkBytes: CHUNK, signal: controller.signal })).rejects.toThrow('stop');
    expect(bridge.calls).toHaveLength(2);
  });

  it('propagates a native error from the bridge', async () => {
    const bridge = fakeBridge(makeFile(100), {
      readChunk: async () => {
        throw new Error('This file is not covered by a granted permission');
      },
    });
    await expect(readRange('u', 0, 10, { transport: bridge })).rejects.toThrow('not covered by a granted permission');
  });
});

describe('readAll', () => {
  const CHUNK = 8;

  it.each([1, 7, 8, 9, 15, 16, 17, 24, 100])('reads a %i-byte file exactly, into one preallocated buffer', async (size) => {
    const file = makeFile(size);
    const bridge = fakeBridge(file);
    const out = await readAll('u', { transport: bridge, chunkBytes: CHUNK });
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(size);
    // One allocation of exactly getSize() bytes - not a concatenation of pieces.
    expect(out.buffer.byteLength).toBe(size);
    expect(Array.from(out)).toEqual(Array.from(file));
    expect(bridge.calls.length).toBe(Math.ceil(size / CHUNK));
    expect(bridge.calls.every((c, i) => c.offset === i * CHUNK)).toBe(true);
  });

  it('rejects an empty file with a clear message', async () => {
    await expect(readAll('u', { transport: fakeBridge(new Uint8Array(0)) })).rejects.toThrow('This file is empty');
  });

  it('rejects a file over MAX_BOOK_BYTES with FileTooLargeError, before reading anything', async () => {
    const bridge = fakeBridge(makeFile(4), { getSize: async () => MAX_BOOK_BYTES + 1 });
    const error = await readAll('u', { transport: bridge }).catch((e) => e);
    expect(error).toBeInstanceOf(FileTooLargeError);
    expect(error.message).toMatch(/1,024 MB limit/);
    expect(bridge.calls).toHaveLength(0);
  });

  it('accepts a file of exactly MAX_BOOK_BYTES as far as the size check goes', async () => {
    // Don't allocate 1 GiB in a unit test: abort right after the size check passes.
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const bridge = fakeBridge(makeFile(4), { getSize: async () => MAX_BOOK_BYTES });
    const error = await readAll('u', { transport: bridge, signal: controller.signal }).catch((e) => e);
    expect(error).not.toBeInstanceOf(FileTooLargeError);
  });

  it('fails clearly if the file is shorter than its reported size', async () => {
    const bridge = fakeBridge(makeFile(20), { getSize: async () => 30 });
    await expect(readAll('u', { transport: bridge, chunkBytes: CHUNK })).rejects.toThrow(/changed while it was being read \(expected 30 bytes, got 20\)/);
  });

  it('rejects a nonsensical size from the native side', async () => {
    for (const size of [-1, 1.5, Number.NaN]) {
      await expect(getSize('u', fakeBridge(makeFile(1), { getSize: async () => size }))).rejects.toThrow(RangeError);
    }
  });
});

describe('createFileSource', () => {
  it('exposes the size and reads [begin, end) clamped to the file', async () => {
    const file = makeFile(50);
    const bridge = fakeBridge(file);
    const source = await createFileSource('u', { transport: bridge, chunkBytes: 8 });
    expect(source.size).toBe(50);
    expect(Array.from(await source.read(10, 30))).toEqual(Array.from(file.subarray(10, 30)));
    expect(Array.from(await source.read(40, 9999))).toEqual(Array.from(file.subarray(40)));
    expect(await source.read(50, 60)).toHaveLength(0);
    expect(await source.read(30, 30)).toHaveLength(0);
  });

  it('applies the same size ceiling and empty-file check', async () => {
    await expect(createFileSource('u', { transport: fakeBridge(makeFile(1), { getSize: async () => MAX_BOOK_BYTES + 1 }) })).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    await expect(createFileSource('u', { transport: fakeBridge(new Uint8Array(0)) })).rejects.toThrow('This file is empty');
  });
});
