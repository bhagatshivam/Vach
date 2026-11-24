// Stands in for src/lib/epubFile.ts inside the frame check (frame-chromium.mjs): opens the sample EPUB the
// page was given instead of reading a SAF file, so the REAL ReaderScreen can run in headless Chromium.
import JSZip from 'jszip';
import { archiveFromJSZip, openEpub, type EpubBook } from '../../src/lib/epub';

export async function openEpubFile(): Promise<EpubBook> {
  const base64 = (window as unknown as { __sampleEpub: string }).__sampleEpub;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const book = await openEpub(archiveFromJSZip(await JSZip.loadAsync(bytes)), 'Sample');
  // A phone parses chapters far slower than this machine: when asked to, take that long per streamed chapter, so the
  // reader is still streaming the book in when a Contents jump happens (which is what makes it reopen the window).
  const delay = (window as unknown as { __streamDelayMs?: number }).__streamDelayMs ?? 0;
  if (delay > 0) {
    const stream = book.stream.bind(book);
    book.stream = async function* (startIndex?: number) {
      for await (const event of stream(startIndex)) {
        if (event.type === 'chapter') await new Promise((resolve) => setTimeout(resolve, delay));
        yield event;
      }
    };
  }
  return book;
}
