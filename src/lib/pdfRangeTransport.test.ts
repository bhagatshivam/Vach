import { describe, expect, it, vi } from 'vitest';
import { createFileSource, type ChunkTransport } from './fileBridge';
import { BridgeRangeTransport, PDF_INITIAL_BYTES, PDF_RANGE_CHUNK_BYTES } from './pdfRangeTransport';

// Same fake native side as fileBridge.test.ts, kept local on purpose: this
// file tests the adapter + bridge together, the way pdf.js drives them.
function makeFile(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 13 + 5) & 0xff;
  return bytes;
}

function fakeTransport(file: Uint8Array, calls: Array<{ offset: number; length: number }> = []): ChunkTransport {
  return {
    getSize: async () => file.length,
    readChunk: async (_uri, offset, length) => {
      calls.push({ offset, length });
      const slice = file.subarray(Math.min(offset, file.length), Math.min(offset + length, file.length));
      return { base64: Buffer.from(slice).toString('base64'), length: slice.length };
    },
  };
}

type RangeMessage = { type: string; begin?: number; chunk?: Uint8Array };

async function setup(fileSize: number, chunkBytes = 8) {
  const file = makeFile(fileSize);
  const calls: Array<{ offset: number; length: number }> = [];
  const source = await createFileSource('content://book.pdf', { transport: fakeTransport(file, calls), chunkBytes });
  const transport = new BridgeRangeTransport(source.size, null, false, source.read);
  const messages: RangeMessage[] = [];
  transport.transportReady((m: RangeMessage) => messages.push(m));
  return { file, calls, source, transport, messages };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('BridgeRangeTransport', () => {
  it('keeps the constants pdf.js alignment rules depend on', () => {
    // pdf.js throws "Bad begin/end offset" for ranges not aligned to rangeChunkSize.
    expect(PDF_INITIAL_BYTES % PDF_RANGE_CHUNK_BYTES).toBe(0);
  });

  it('exposes length, initial data and progressiveDone to pdf.js', () => {
    const initial = new Uint8Array([1, 2, 3]);
    const transport = new BridgeRangeTransport(1000, initial, true, async () => new Uint8Array(0));
    expect(transport.length).toBe(1000);
    expect(transport.initialData).toBe(initial);
    expect(transport.progressiveDone).toBe(true);
  });

  it('answers requestDataRange(begin, end) with exactly those bytes, via onDataRange', async () => {
    const { file, transport, messages } = await setup(100);
    transport.requestDataRange(16, 40);
    await flush();
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('range');
    expect(messages[0].begin).toBe(16);
    expect(Array.from(messages[0].chunk!)).toEqual(Array.from(file.subarray(16, 40)));
  });

  it('a range spanning several bridge chunks arrives as ONE onDataRange call (pdf.js matches one reply per request)', async () => {
    const { file, calls, transport, messages } = await setup(100, 8);
    transport.requestDataRange(8, 8 + 8 * 5 + 3);
    await flush();
    expect(calls.length).toBe(6); // 5 full + 1 short bridge chunk
    expect(messages).toHaveLength(1);
    expect(messages[0].begin).toBe(8);
    expect(Array.from(messages[0].chunk!)).toEqual(Array.from(file.subarray(8, 8 + 8 * 5 + 3)));
  });

  it('serves the last, short range of the file (end == file length)', async () => {
    const { file, transport, messages } = await setup(30, 8);
    transport.requestDataRange(24, 30);
    await flush();
    expect(Array.from(messages[0].chunk!)).toEqual(Array.from(file.subarray(24)));
  });

  it('handles several concurrent requests, each answered with its own begin', async () => {
    const { file, transport, messages } = await setup(100, 8);
    transport.requestDataRange(0, 16);
    transport.requestDataRange(64, 80);
    await flush();
    const byBegin = new Map(messages.map((m) => [m.begin, m.chunk!]));
    expect(Array.from(byBegin.get(0)!)).toEqual(Array.from(file.subarray(0, 16)));
    expect(Array.from(byBegin.get(64)!)).toEqual(Array.from(file.subarray(64, 80)));
  });

  it('a bridge failure records fatalError, fires onFatal once, and delivers nothing', async () => {
    const source = {
      size: 100,
      read: async () => {
        throw new Error('This file is not covered by a granted permission');
      },
    };
    const transport = new BridgeRangeTransport(100, null, false, source.read);
    const messages: RangeMessage[] = [];
    transport.transportReady((m: RangeMessage) => messages.push(m));
    const onFatal = vi.fn();
    transport.onFatal = onFatal;

    transport.requestDataRange(0, 8);
    transport.requestDataRange(8, 16);
    await flush();

    expect(messages).toHaveLength(0);
    expect(transport.fatalError?.message).toMatch(/not covered by a granted permission/);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('a short read (file shrank) is treated as a failure, not handed to pdf.js truncated', async () => {
    const source = { size: 100, read: async () => new Uint8Array(5) };
    const transport = new BridgeRangeTransport(100, null, false, source.read);
    const messages: RangeMessage[] = [];
    transport.transportReady((m: RangeMessage) => messages.push(m));
    transport.requestDataRange(0, 8);
    await flush();
    expect(messages).toHaveLength(0);
    expect(transport.fatalError?.message).toMatch(/file changed while it was being read/);
  });

  it('after abort(), in-flight results are dropped and new requests do not touch the bridge', async () => {
    const read = vi.fn(async (begin: number, end: number) => new Uint8Array(end - begin));
    const transport = new BridgeRangeTransport(100, null, false, read);
    const messages: RangeMessage[] = [];
    transport.transportReady((m: RangeMessage) => messages.push(m));

    transport.requestDataRange(0, 8); // in flight
    transport.abort();
    transport.requestDataRange(8, 16); // after abort
    await flush();

    expect(read).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(0);
    expect(transport.fatalError).toBeNull();
  });

  it('passes an abort signal to the reader so a cancelled open can stop its bridge calls', async () => {
    let seen: AbortSignal | undefined;
    const read = async (begin: number, end: number, signal?: AbortSignal) => {
      seen = signal;
      return new Uint8Array(end - begin);
    };
    const transport = new BridgeRangeTransport(100, null, false, read);
    transport.transportReady(() => {});
    transport.requestDataRange(0, 8);
    await flush();
    expect(seen).toBeDefined();
    transport.abort();
    expect(seen!.aborted).toBe(true);
  });
});
