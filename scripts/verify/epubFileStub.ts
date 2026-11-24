// Stands in for src/lib/epubFile.ts inside the frame check (frame-chromium.mjs): opens the sample EPUB the
// page was given instead of reading a SAF file, so the REAL ReaderScreen can run in headless Chromium.
import JSZip from 'jszip';
import { archiveFromJSZip, openEpub, type EpubBook } from '../../src/lib/epub';

export async function openEpubFile(): Promise<EpubBook> {
  const base64 = (window as unknown as { __sampleEpub: string }).__sampleEpub;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return openEpub(archiveFromJSZip(await JSZip.loadAsync(bytes)), 'Sample');
}
