// Stands in for src/lib/pdf.ts in the mounting measurements: a synthetic PDF of `pages` pages, with the same shape the real
// text pass produces (one chapter per page: ordinary paragraphs for a text page, a fixed-ratio placeholder figure for a
// scanned one), so the REAL reader and PdfPageLoader run against a large PDF without pdf.js or a file.
//
// window.__syntheticPdf = { pages: number, scanned?: boolean }
import type { ParseEvent, PendingPdfRender } from '../../src/lib/pdf';

const WORDS = 'the caravan reached the ridge at dusk and from there the whole valley lay open beneath them the river the long road the lamps of the town coming on one by one'.split(' ');

function pageText(page: number): string {
  // ~2,400 characters in 4 paragraphs: a dense A4 page of running text.
  let seed = page * 7919;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const paragraphs: string[] = [];
  for (let p = 0; p < 4; p++) {
    const words: string[] = [];
    while (words.join(' ').length < 600) words.push(WORDS[next() % WORDS.length]);
    paragraphs.push(`<p>${words.join(' ')}</p>`);
  }
  return paragraphs.join('');
}

export async function openPdf() {
  const config = (window as unknown as { __syntheticPdf: { pages: number; scanned?: boolean } }).__syntheticPdf;
  return {
    async *streamChapters(): AsyncGenerator<ParseEvent> {
      yield { type: 'title', title: 'Synthetic PDF' };
      yield { type: 'total', count: config.pages };
      for (let page = 1; page <= config.pages; page++) {
        const html = config.scanned
          ? `<figure class="pdf-page" id="pdf-page-${page}" style="aspect-ratio:595.00/842.00"><img class="pdf-page-img" alt="" draggable="false"/></figure>`
          : `<h3>MARK_${page - 1}</h3>${pageText(page)}`;
        yield { type: 'chapter', html, pageKind: config.scanned ? 'image' : 'text' } as ParseEvent;
        // Yield to the event loop now and then, as a real text pass does between pages.
        if (page % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    async getOutline() {
      return [];
    },
    renderPageImage(): PendingPdfRender {
      return { promise: Promise.resolve(null), cancel: () => {} };
    },
    destroy() {},
  };
}
