import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { openEpubFile } from './epubFile';
import type { ChunkTransport } from './fileBridge';

// The same TOC and weights from the ranged (large-file) path as from the in-memory one, with no chapter read for them.

async function epub(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const items = [0, 1, 2].map((i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest>${items}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine>${[0, 1, 2].map((i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`);
  zip.file('OEBPS/nav.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="c0.xhtml">One</a></li><li><a href="c2.xhtml#end">Three</a></li></ol></nav></body></html>');
  [10, 200, 3000].forEach((n, i) => zip.file(`OEBPS/c${i}.xhtml`, `<html><body>${'<p>text text text</p>'.repeat(n)}</body></html>`, { compression: 'STORE' }));
  return zip.generateAsync({ type: 'uint8array' });
}

function transportOver(bytes: Uint8Array) {
  const reads: Array<[number, number]> = [];
  const transport: ChunkTransport = {
    getSize: async () => bytes.length,
    readChunk: async (_uri, offset, length) => {
      reads.push([offset, offset + length]);
      const slice = bytes.subarray(offset, offset + length);
      return { base64: Buffer.from(slice).toString('base64'), length: slice.length };
    },
  };
  return { transport, reads };
}

describe('openEpubFile - table of contents and weights', () => {
  it.each([
    ['whole-file path', Number.MAX_SAFE_INTEGER],
    ['ranged path', 0],
  ])('%s: TOC maps to chapters and weights follow the real sizes', async (_name, wholeFileMaxBytes) => {
    const bytes = await epub();
    const { transport } = transportOver(bytes);
    const book = await openEpubFile('content://x/b.epub', 'fallback', { transport, wholeFileMaxBytes });
    const toc = await book.toc();
    expect(toc.map((i) => [i.title, i.chapterIndex, i.fragment])).toEqual([['One', 0, undefined], ['Three', 2, 'end']]);
    const weights = book.chapterWeights!;
    expect(weights).toHaveLength(3);
    expect(weights[0]).toBeLessThan(weights[1]);
    expect(weights[1]).toBeLessThan(weights[2]);
    expect(weights[2]).toBeGreaterThan(40000);
  });

  it('on the ranged path, opening and reading the TOC fetches only a fraction of the file (no chapter data)', async () => {
    // Pad the archive so chapters dominate its size.
    const zip = await JSZip.loadAsync(await epub());
    zip.file('OEBPS/c2.xhtml', `<html><body>${'<p>padding padding padding padding</p>'.repeat(60000)}</body></html>`, { compression: 'STORE' });
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const { transport, reads } = transportOver(bytes);
    const book = await openEpubFile('content://x/b.epub', 'fallback', { transport, wholeFileMaxBytes: 0 });
    await book.toc();
    const total = reads.reduce((n, [a, b]) => n + (b - a), 0);
    expect(bytes.length).toBeGreaterThan(1_000_000);
    expect(total).toBeLessThan(bytes.length / 2);
  });
});
