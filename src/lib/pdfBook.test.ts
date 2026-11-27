import { describe, expect, it, vi } from 'vitest';
import { pageKindOfHtml, pdfAsBook } from './pdfBook';
import type { PdfHandle } from './pdf';

function fakeHandle(overrides: Partial<PdfHandle> = {}): PdfHandle {
  return {
    title: 'A PDF',
    numPages: 120,
    loadPage: vi.fn(async (index: number) => ({ html: `<p>page ${index + 1}</p>`, pageKind: 'text' as const })),
    cancelPending: vi.fn(() => 3),
    streamChapters: vi.fn(async function* (startIndex = 0) {
      yield { type: 'title' as const, title: 'A PDF' };
      yield { type: 'total' as const, count: 120 };
      yield { type: 'chapter' as const, html: `<p>page ${startIndex + 1}</p>`, pageKind: 'text' as const };
    }),
    getOutline: vi.fn(async () => []),
    renderPageImage: vi.fn(() => ({ promise: Promise.resolve(null), cancel: () => {} })),
    destroy: vi.fn(),
    ...overrides,
  };
}

describe('pdfAsBook', () => {
  it('is a book of pages: the page count is the chapter count, the title is the document\'s', () => {
    const book = pdfAsBook(fakeHandle());
    expect(book.chapterCount).toBe(120);
    expect(book.title).toBe('A PDF');
  });

  it('progress counts pages equally (no sizes)', () => {
    expect(pdfAsBook(fakeHandle()).chapterWeights).toBeNull();
  });

  it('a chapter is a page, extracted only when asked for', async () => {
    const handle = fakeHandle();
    const book = pdfAsBook(handle);
    expect(handle.loadPage).not.toHaveBeenCalled();
    expect(await book.loadChapter(41)).toBe('<p>page 42</p>');
    expect(handle.loadPage).toHaveBeenCalledTimes(1);
    expect(handle.loadPage).toHaveBeenCalledWith(41);
  });

  it('the stream starts where it is told to, and is the handle\'s', async () => {
    const handle = fakeHandle();
    const events = [];
    for await (const event of pdfAsBook(handle).stream(7)) events.push(event);
    expect(handle.streamChapters).toHaveBeenCalledWith(7);
    expect(events.at(-1)).toMatchObject({ type: 'chapter', html: '<p>page 8</p>' });
  });

  it('the table of contents is the outline', async () => {
    const outline = [{ id: 't0', title: 'Part', chapterIndex: 3, depth: 0, children: [] }];
    const book = pdfAsBook(fakeHandle({ getOutline: vi.fn(async () => outline) }));
    expect(await book.toc()).toBe(outline);
  });

  it('pages the reader no longer needs can be dropped', () => {
    const handle = fakeHandle();
    expect(pdfAsBook(handle).cancelPending()).toBe(3);
    expect(handle.cancelPending).toHaveBeenCalled();
  });

  it('closing the book releases the document', () => {
    const handle = fakeHandle();
    pdfAsBook(handle).close();
    expect(handle.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('pageKindOfHtml', () => {
  it('tells a scanned page from a text page and a blank one', () => {
    expect(pageKindOfHtml('<figure class="pdf-page" id="pdf-page-3" style="aspect-ratio:1/1"><img class="pdf-page-img"/></figure>')).toBe('raster');
    expect(pageKindOfHtml('<p>Some text</p>')).toBe('text');
    expect(pageKindOfHtml('')).toBe('blank');
  });
});
