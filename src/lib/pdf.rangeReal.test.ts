import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { FileSource } from './fileBridge';

// Real pdf.js (legacy build, fake in-process worker) reading a real
// multi-megabyte PDF exclusively through this app's range transport.
// Complements pdf.rangeOpen.test.ts, which mocks pdf.js: this one proves the
// transport semantics are what pdf.js really expects (aligned ranges, one
// reply per request, initialData handling).
//
// Promise.try is polyfilled because the fake worker needs it and the Node
// versions that can run this suite don't all have it (see the note in
// pdf.password.test.ts). Real Chromium has it natively.
if (typeof (Promise as unknown as { try?: unknown }).try !== 'function') {
  (Promise as unknown as { try: (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => Promise<unknown> }).try = (fn, ...args) =>
    new Promise((resolve) => resolve(fn(...args)));
}

vi.mock('./pdfWorkerEntry.ts?worker&url', () => ({
  default: pathToFileURL(`${process.cwd()}/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`).href,
}));

const MIB = 1024 * 1024;

async function buildPdf(pages: string[], paddingBytes: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  // A large, never-referenced stream between the page objects and the xref:
  // pdf.js has to jump around the file (header, then the xref at the end,
  // then page objects) rather than read it start to finish.
  const filler = new Uint8Array(paddingBytes);
  for (let i = 0; i < filler.length; i++) filler[i] = (i * 2654435761) >>> 24;
  pdf.context.register(pdf.context.stream(filler));
  for (const text of pages) {
    const page = pdf.addPage([400, 600]);
    page.drawText(text, { x: 40, y: 500, size: 14, font });
  }
  return pdf.save({ useObjectStreams: false });
}

function sourceOf(bytes: Uint8Array): FileSource & { reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  return {
    size: bytes.length,
    reads,
    read: async (begin, end) => {
      reads.push([begin, end]);
      return bytes.slice(begin, Math.min(end, bytes.length));
    },
  };
}

describe('openPdf against real pdf.js through the range transport', () => {
  it('opens a multi-MiB PDF, extracts its text, and never reads outside the file', async () => {
    const pdfBytes = await buildPdf(['ALPHA marker page one', 'BRAVO marker page two', 'CHARLIE marker page three'], 3 * MIB + 12345);
    expect(pdfBytes.length).toBeGreaterThan(3 * MIB);
    const src = sourceOf(pdfBytes);

    const { openPdf } = await import('./pdf');
    const handle = await openPdf(src, 'fallback.pdf');
    const events: Array<{ type: string; html?: string; count?: number }> = [];
    for await (const event of handle.streamChapters()) events.push(event);
    handle.destroy();

    expect(events.find((e) => e.type === 'total')?.count).toBe(3);
    const html = events.filter((e) => e.type === 'chapter').map((e) => e.html).join('\n');
    expect(html).toContain('ALPHA marker page one');
    expect(html).toContain('BRAVO marker page two');
    expect(html).toContain('CHARLIE marker page three');

    // Every read was inside the file, and pdf.js's ranged reads (after the
    // initial 1 MiB window) were aligned to its 1 MiB chunk size.
    for (const [begin, end] of src.reads) {
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(pdfBytes.length);
      expect(end).toBeGreaterThan(begin);
    }
    const ranged = src.reads.slice(1);
    // pdf.js really used range requests (the xref/pages beyond the initial
    // window) and, with auto-fetch off, did not need the unreferenced
    // multi-MiB stream in the middle of the file.
    expect(ranged.length).toBeGreaterThan(0);
    expect(src.reads.reduce((total, [begin, end]) => total + (end - begin), 0)).toBeLessThan(pdfBytes.length);
    for (const [begin, end] of ranged) {
      expect(begin % MIB).toBe(0);
      expect(end % MIB === 0 || end === pdfBytes.length).toBe(true);
    }
  }, 30000);

  it('opens a tiny PDF that fits entirely in the initial window', async () => {
    const pdfBytes = await buildPdf(['TINY marker'], 100);
    expect(pdfBytes.length).toBeLessThan(MIB);
    const src = sourceOf(pdfBytes);
    const { openPdf } = await import('./pdf');
    const handle = await openPdf(src, 'tiny.pdf');
    const html: string[] = [];
    for await (const event of handle.streamChapters()) if (event.type === 'chapter') html.push(event.html);
    handle.destroy();
    expect(html.join('')).toContain('TINY marker');
  }, 30000);
});
