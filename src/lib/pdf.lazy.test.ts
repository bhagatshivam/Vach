import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { FileSource } from './fileBridge';
import { PageCancelledError } from './pdfPages';

// Real pdf.js (legacy build, fake in-process worker) reading a real multi-megabyte PDF through the range transport, to prove what
// the lazy reader relies on: a page's text can be extracted on its own, in any order, without reading the pages before it, and
// the pages that were asked for but not started can be dropped. (Same arrangement as pdf.rangeReal.test.ts.)

if (typeof (Promise as unknown as { try?: unknown }).try !== 'function') {
  (Promise as unknown as { try: (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => Promise<unknown> }).try = (fn, ...args) =>
    new Promise((resolve) => resolve(fn(...args)));
}

vi.mock('./pdfWorkerEntry.ts?worker&url', () => ({
  default: pathToFileURL(`${process.cwd()}/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`).href,
}));

const MIB = 1024 * 1024;
const PAGES = 60;

/** 60 pages, each followed by ~100 KB that nothing refers to, in a file with the cross-reference in object streams (what most producers write). */
async function buildPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const filler = new Uint8Array(100 * 1024);
  for (let i = 0; i < filler.length; i++) filler[i] = (i * 2654435761) >>> 24;
  for (let p = 0; p < PAGES; p++) {
    const page = pdf.addPage([400, 600]);
    page.drawText(`MARK ${p} is on this page`, { x: 40, y: 500, size: 14, font });
    pdf.context.register(pdf.context.stream(filler));
  }
  return pdf.save({ useObjectStreams: true });
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

describe('openPdf: pages are extracted when asked for, and only then', () => {
  it('opens knowing the page count and title having read only the start and end of the file, and extracts a page when asked', async () => {
    const bytes = await buildPdf();
    expect(bytes.length).toBeGreaterThan(5 * MIB);
    const src = sourceOf(bytes);
    const { openPdf } = await import('./pdf');
    const handle = await openPdf(src, 'fallback.pdf');
    try {
      expect(handle.numPages).toBe(PAGES);
      expect(handle.title).toBe('fallback.pdf');
      // Opening knows how many pages there are without having read the pages: the first MiB and the cross-reference table at the end.
      const readAtOpen = src.reads.reduce((n, [b, e]) => n + (e - b), 0);
      expect(readAtOpen).toBeLessThan(bytes.length * 0.5);

      // The first page, extracted on its own, costs a few more reads - nothing like the whole file.
      const first = await handle.loadPage(0);
      expect(first.pageKind).toBe('text');
      expect(first.html).toContain('MARK 0 is on this page');
      expect(src.reads.reduce((n, [b, e]) => n + (e - b), 0)).toBeLessThan(bytes.length * 0.7);

      // A page from the far end is extracted too, whatever came before it.
      expect((await handle.loadPage(57)).html).toContain('MARK 57 is on this page');
    } finally {
      handle.destroy();
    }
  });

  it('pages can be asked for in any order, repeatedly, and each is its own page', async () => {
    const { openPdf } = await import('./pdf');
    const handle = await openPdf(sourceOf(await buildPdf()), 'f.pdf');
    try {
      const [a, b, c] = await Promise.all([handle.loadPage(40), handle.loadPage(3), handle.loadPage(40)]);
      expect(a.html).toContain('MARK 40 ');
      expect(b.html).toContain('MARK 3 ');
      expect(c.html).toBe(a.html);
      expect((await handle.loadPage(3)).html).toBe(b.html); // again, later
    } finally {
      handle.destroy();
    }
  });

  it('a page outside the document is a RangeError, not a blank page', async () => {
    const { openPdf } = await import('./pdf');
    const handle = await openPdf(sourceOf(await buildPdf()), 'f.pdf');
    try {
      await expect(handle.loadPage(PAGES)).rejects.toBeInstanceOf(RangeError);
      await expect(handle.loadPage(-1)).rejects.toBeInstanceOf(RangeError);
    } finally {
      handle.destroy();
    }
  });

  it('streamChapters(start) yields the title, the total, and the pages from start on - and only those', async () => {
    const { openPdf } = await import('./pdf');
    const handle = await openPdf(sourceOf(await buildPdf()), 'f.pdf');
    try {
      const events = [];
      for await (const event of handle.streamChapters(57)) events.push(event);
      expect(events.map((e) => e.type)).toEqual(['title', 'total', 'chapter', 'chapter', 'chapter']);
      expect(events[1]).toEqual({ type: 'total', count: PAGES });
      const html = events.filter((e) => e.type === 'chapter').map((e) => (e as { html: string }).html);
      expect(html[0]).toContain('MARK 57 ');
      expect(html[2]).toContain('MARK 59 ');
    } finally {
      handle.destroy();
    }
  });

  it('cancelPending drops the pages that have not started and leaves the one that is running', async () => {
    const { openPdf } = await import('./pdf');
    const handle = await openPdf(sourceOf(await buildPdf()), 'f.pdf');
    try {
      const running = handle.loadPage(10);
      const waiting = [handle.loadPage(11), handle.loadPage(12)];
      expect(handle.cancelPending()).toBe(2);
      for (const page of waiting) await expect(page).rejects.toBeInstanceOf(PageCancelledError);
      expect((await running).html).toContain('MARK 10 ');
      // and the reader can still ask for them again
      expect((await handle.loadPage(11)).html).toContain('MARK 11 ');
    } finally {
      handle.destroy();
    }
  });

  it('after destroy() nothing more is extracted', async () => {
    const { openPdf } = await import('./pdf');
    const handle = await openPdf(sourceOf(await buildPdf()), 'f.pdf');
    handle.destroy();
    await expect(handle.loadPage(1)).rejects.toBeInstanceOf(PageCancelledError);
  });
});
