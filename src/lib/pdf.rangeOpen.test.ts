import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileSource } from './fileBridge';

// pdf.js itself is mocked (see pdf.password.test.ts for why a real
// getDocument() can't run under vitest/Node). What this file verifies is the
// part this app owns: how openPdf wires the chunked bridge into pdf.js - the
// options it passes, the initial data it hands over, and what happens when a
// bridge read fails mid-document.

interface GetDocumentArgs {
  range: {
    length: number;
    initialData: Uint8Array;
    progressiveDone: boolean;
    requestDataRange(b: number, e: number): void;
    transportReady(listener: (message: unknown) => void): void;
  };
  rangeChunkSize: number;
  disableAutoFetch: boolean;
  disableStream: boolean;
  data?: unknown;
}

const mocks = vi.hoisted(() => ({
  lastArgs: null as GetDocumentArgs | null,
  destroy: vi.fn(async () => {}),
  makeDoc: null as null | ((args: GetDocumentArgs) => unknown),
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>();
  return {
    OPS: actual.OPS,
    PDFDataRangeTransport: actual.PDFDataRangeTransport,
    GlobalWorkerOptions: {},
    getDocument: (args: GetDocumentArgs) => {
      mocks.lastArgs = args;
      return {
        promise: Promise.resolve(mocks.makeDoc!(args)),
        destroy: mocks.destroy,
      };
    },
  };
});
vi.mock('./pdfWorkerEntry.ts?worker&url', () => ({ default: 'fake-worker-url' }));

const { openPdf } = await import('./pdf');

const MIB = 1024 * 1024;

function source(size: number, read?: FileSource['read']): FileSource & { reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  return {
    size,
    reads,
    read:
      read ??
      (async (begin, end) => {
        reads.push([begin, end]);
        return new Uint8Array(end - begin).fill(7);
      }),
  };
}

function emptyDoc() {
  return {
    numPages: 1,
    getMetadata: async () => ({ info: {} }),
    getPage: async () => {
      throw new Error('unused');
    },
    loadingTask: { destroy: mocks.destroy },
  };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

beforeEach(() => {
  mocks.lastArgs = null;
  mocks.destroy.mockClear();
  mocks.makeDoc = () => emptyDoc();
});

describe('openPdf - range transport wiring', () => {
  it('opens through a PDFDataRangeTransport (no `data` buffer), with range-friendly options', async () => {
    await openPdf(source(5 * MIB), 'big.pdf');
    const args = mocks.lastArgs!;
    expect(args.data).toBeUndefined();
    expect(args.range.length).toBe(5 * MIB);
    expect(args.rangeChunkSize).toBe(MIB);
    expect(args.disableAutoFetch).toBe(true);
    expect(args.disableStream).toBe(true);
  });

  it('reads only the first 1 MiB up front for a large file, and says the stream is not done', async () => {
    const src = source(300 * MIB);
    await openPdf(src, 'huge.pdf');
    expect(src.reads).toEqual([[0, MIB]]);
    expect(mocks.lastArgs!.range.initialData.length).toBe(MIB);
    expect(mocks.lastArgs!.range.progressiveDone).toBe(false);
  });

  it('a file no bigger than the initial window is handed over whole and marked done', async () => {
    const src = source(1234);
    await openPdf(src, 'small.pdf');
    expect(src.reads).toEqual([[0, 1234]]);
    expect(mocks.lastArgs!.range.initialData.length).toBe(1234);
    expect(mocks.lastArgs!.range.progressiveDone).toBe(true);
  });

  it('a file of exactly 1 MiB counts as fully delivered', async () => {
    await openPdf(source(MIB), 'edge.pdf');
    expect(mocks.lastArgs!.range.progressiveDone).toBe(true);
  });

  it('a file of 1 MiB + 1 byte is not', async () => {
    await openPdf(source(MIB + 1), 'edge.pdf');
    expect(mocks.lastArgs!.range.progressiveDone).toBe(false);
  });

  it('range requests from pdf.js are served from the file source, not from memory', async () => {
    const src = source(10 * MIB);
    await openPdf(src, 'a.pdf');
    const delivered: unknown[] = [];
    // pdf.js always attaches its listener (transportReady) before requesting ranges.
    mocks.lastArgs!.range.transportReady((message) => delivered.push(message));
    mocks.lastArgs!.range.requestDataRange(3 * MIB, 4 * MIB);
    await new Promise((r) => setTimeout(r, 0));
    expect(src.reads).toContainEqual([3 * MIB, 4 * MIB]);
    expect(delivered).toHaveLength(1);
  });

  it('destroy() tears down the pdf.js document exactly once', async () => {
    const handle = await openPdf(source(100), 'a.pdf');
    handle.destroy();
    handle.destroy();
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('openPdf - bridge failure mid-document', () => {
  it('destroys the document and surfaces the real cause instead of a page of "could not be loaded" placeholders', async () => {
    let failingRead = false;
    const src = source(10 * MIB, async (begin, end) => {
      if (failingRead) throw new Error('Failed to read file: Input/output error');
      return new Uint8Array(end - begin);
    });
    // Two pages: the first triggers a range request that fails at the bridge;
    // pdf.js would then reject every page with a generic "destroyed" error.
    mocks.makeDoc = (args) => ({
      numPages: 2,
      getMetadata: async () => ({ info: {} }),
      getPage: async () => {
        failingRead = true;
        args.range.requestDataRange(2 * MIB, 3 * MIB);
        await new Promise((r) => setTimeout(r, 0));
        throw new Error('Worker was destroyed');
      },
      loadingTask: { destroy: mocks.destroy },
    });

    const handle = await openPdf(src, 'a.pdf');
    await expect(drain(handle.streamChapters())).rejects.toThrow('Failed to read file: Input/output error');
    expect(mocks.destroy).toHaveBeenCalled(); // onFatal tore the document down
  });

  it('reports a bridge failure while opening (before any page) as that error, not a generic pdf.js one', async () => {
    mocks.makeDoc = () => {
      throw new Error('should not be reached');
    };
    const src = source(10 * MIB, async () => {
      throw new Error('This file is not covered by a granted permission');
    });
    await expect(openPdf(src, 'a.pdf')).rejects.toThrow('not covered by a granted permission');
  });
});
