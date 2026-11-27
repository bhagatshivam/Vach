// A PDF seen as a book: pages are chapters (chapter k is page k + 1), and a page's text is only extracted when the reader asks
// for it. That is all the reader's window manager needs, so a PDF is mounted, loaded and unmounted exactly like an EPUB or a
// Word document - ahead of and behind the reader, a bounded number of pages at a time, however long the PDF is.
//
// Pictures: a PDF page has no <img> of the book's own (a scanned page is a placeholder the page loader rasterizes), so the
// image store here is an empty one that only exists because the reader asks every book for one.

import type { EpubBook } from './epub';
import { ImageStore } from './imageProcessor';
import type { PageKind, ParseEvent, PdfHandle } from './pdf';

/** What kind of page some page HTML is: the reader reads this back from the HTML of a page it loaded, to spot a scanned book. */
export function pageKindOfHtml(html: string): PageKind {
  if (html.includes('class="pdf-page"')) return 'raster';
  return html ? 'text' : 'blank';
}

export interface PdfBook extends EpubBook {
  /** Drops the pages that were asked for and have not started: the reader jumped and does not need them. */
  cancelPending(): number;
}

export function pdfAsBook(handle: PdfHandle): PdfBook {
  const images = new ImageStore();
  return {
    title: handle.title,
    chapterCount: handle.numPages,
    // Pages count equally: progress is page-based, never by size.
    chapterWeights: null,
    images,
    loadChapter: async (index) => (await handle.loadPage(index)).html,
    cancelPending: () => handle.cancelPending(),
    stream: (startIndex = 0): AsyncGenerator<ParseEvent> => handle.streamChapters(startIndex),
    toc: () => handle.getOutline(),
    close() {
      images.revokeAll();
      handle.destroy();
    },
  };
}
