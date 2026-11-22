// Runs INSIDE headless Chromium (bundled by chromium-check.mjs): checks that
// DecompressionStream('deflate-raw'), the central-directory reader and the
// whole-file/ranged EPUB paths behave in a real browser engine, not just Node.
import { openEpubFile } from '../../src/lib/epubFile';
import type { ChunkTransport } from '../../src/lib/fileBridge';
import { openZip, type ZipByteSource } from '../../src/lib/zipReader';

const toBytes = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function memorySource(bytes: Uint8Array): ZipByteSource {
  return { size: bytes.length, read: async (begin, end) => bytes.slice(begin, end) };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function memoryTransport(bytes: Uint8Array): { transport: ChunkTransport; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    transport: {
      getSize: async () => bytes.length,
      readChunk: async (_uri, offset, length) => {
        calls++;
        const slice = bytes.subarray(Math.min(offset, bytes.length), Math.min(offset + length, bytes.length));
        return { base64: toBase64(slice), length: slice.length };
      },
    },
  };
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const api = {
  env() {
    return {
      userAgent: navigator.userAgent,
      decompressionStream: typeof DecompressionStream,
      compressionStream: typeof CompressionStream,
    };
  },

  /** deflate-raw round trip with the browser's own CompressionStream/DecompressionStream. */
  async deflateRawRoundTrip() {
    const original = new TextEncoder().encode('Vach वाच '.repeat(5000));
    const compressed = await streamToBytes(
      new Blob([original as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw')) as ReadableStream<Uint8Array>,
    );
    const restored = await streamToBytes(
      new Blob([compressed as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')) as ReadableStream<Uint8Array>,
    );
    return { original: original.length, compressed: compressed.length, equal: text(restored) === text(original) };
  },

  /** Entry names and contents of a ZIP with Unicode names, read through zipReader. */
  async unicodeZip(base64: string, expected: Record<string, string>) {
    const archive = await openZip(memorySource(toBytes(base64)));
    const found = [...archive.entries.keys()].sort();
    const mismatches: string[] = [];
    for (const [name, content] of Object.entries(expected)) {
      if (!archive.has(name)) mismatches.push(`missing: ${name}`);
      else if (text(await archive.read(name, 1 << 20)) !== content) mismatches.push(`wrong content: ${name}`);
    }
    return { found, mismatches };
  },

  /** Whole-file path vs ranged path on the same EPUB: identical book, and how long each took here. */
  async epubParity(base64: string) {
    const bytes = toBytes(base64);
    const open = async (wholeFileMaxBytes: number) => {
      const bridge = memoryTransport(bytes);
      const t0 = performance.now();
      const book = await openEpubFile('mem://book', 'fallback.epub', { transport: bridge.transport, wholeFileMaxBytes });
      const openMs = performance.now() - t0;
      const chapters: string[] = [];
      for (let i = 0; i < book.chapterCount; i++) chapters.push(await book.loadChapter(i));
      return { title: book.title, count: book.chapterCount, chapters, openMs, allMs: performance.now() - t0, calls: bridge.calls() };
    };
    const whole = await open(Number.MAX_SAFE_INTEGER);
    const ranged = await open(0);
    return {
      identical: whole.title === ranged.title && whole.count === ranged.count && whole.chapters.every((html, i) => html === ranged.chapters[i]),
      title: whole.title,
      chapters: whole.count,
      bytes: bytes.length,
      whole: { openMs: Math.round(whole.openMs), allMs: Math.round(whole.allMs), calls: whole.calls },
      ranged: { openMs: Math.round(ranged.openMs), allMs: Math.round(ranged.allMs), calls: ranged.calls },
    };
  },

  /** Error behavior of real DecompressionStream on bad input, as surfaced by zipReader. */
  async errorCases(cases: Array<{ name: string; base64: string; entry: string; cap: number }>) {
    const out: Record<string, string> = {};
    for (const { name, base64, entry, cap } of cases) {
      try {
        const archive = await openZip(memorySource(toBytes(base64)));
        const data = await archive.read(entry, cap);
        out[name] = `read ${data.length} bytes without error`;
      } catch (error) {
        out[name] = `${(error as Error).name}: ${(error as Error).message}`;
      }
    }
    return out;
  },
};

(globalThis as unknown as { vachBench: typeof api }).vachBench = api;
