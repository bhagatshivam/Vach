// Stands in for src/lib/docxFile.ts inside the reader checks: opens the sample document the page was given
// (window.__sampleDocx, base64) instead of reading a SAF file, converting on the main thread (the harness bundle has no
// Worker) with the real converter and the real slicer/sanitizer.
import { convertDocx } from '../../src/lib/docxConvert';
import { openDocx } from '../../src/lib/docx';
import type { EpubBook } from '../../src/lib/epub';

export async function openDocxFile(_uri: string, fallbackTitle: string): Promise<EpubBook> {
  const base64 = (window as unknown as { __sampleDocx: string }).__sampleDocx;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return openDocx(bytes.buffer, fallbackTitle, { convert: convertDocx });
}
