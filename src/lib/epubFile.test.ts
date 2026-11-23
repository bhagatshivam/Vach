import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { archiveFromJSZip, openEpub, type EpubArchive } from './epub';
import { EPUB_WHOLE_FILE_MAX_BYTES, openEpubFile } from './epubFile';
import { FileTooLargeError, MAX_BOOK_BYTES, type ChunkTransport } from './fileBridge';
import { ZipFormatError } from './zipReader';

const MIB = 1024 * 1024;
const PNG_1X1 = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

interface FixtureOptions {
  chapters?: number;
  /** Bytes of incompressible, never-referenced data stored after the chapters (makes the file "large"). */
  paddingBytes?: number;
  /** Spine entry that points at a file that isn't in the archive, at this position. */
  missingSpineAt?: number;
  compression?: 'DEFLATE' | 'STORE';
}

async function buildEpub(options: FixtureOptions = {}): Promise<Uint8Array> {
  const count = options.chapters ?? 12;
  const compression = options.compression ?? 'DEFLATE';
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );

  const manifest: string[] = ['<item id="img" href="img/pic.png" media-type="image/png"/>'];
  const spine: string[] = [];
  for (let i = 0; i < count; i++) {
    manifest.push(`<item id="c${i}" href="text/c${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i}"/>`);
    const image = i % 4 === 0 ? '<img src="../img/pic.png" alt="pic"/>' : '';
    zip.file(
      `OEBPS/text/c${i}.xhtml`,
      `<html><body><h2>Chapter ${i}</h2><p>CHAPTER_${i}_TEXT ${'lorem ipsum '.repeat(30)}</p>${image}</body></html>`,
      { compression },
    );
  }
  if (options.missingSpineAt !== undefined) {
    manifest.push('<item id="ghost" href="text/ghost.xhtml" media-type="application/xhtml+xml"/>');
    spine.splice(options.missingSpineAt, 0, '<itemref idref="ghost"/>');
  }
  zip.file('OEBPS/img/pic.png', PNG_1X1, { compression: 'STORE' });
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture Book</dc:title></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`,
  );
  if (options.paddingBytes) {
    const filler = new Uint8Array(options.paddingBytes);
    let x = 12345;
    for (let i = 0; i < filler.length; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      filler[i] = x >>> 24;
    }
    zip.file('OEBPS/media/unused.bin', filler, { compression: 'STORE' });
  }
  return zip.generateAsync({ type: 'uint8array' });
}

function fakeTransport(file: Uint8Array) {
  const reads: Array<{ offset: number; length: number }> = [];
  const transport: ChunkTransport = {
    getSize: async () => {
      return file.length;
    },
    readChunk: async (_uri, offset, length) => {
      reads.push({ offset, length });
      const slice = file.subarray(Math.min(offset, file.length), Math.min(offset + length, file.length));
      return { base64: Buffer.from(slice).toString('base64'), length: slice.length };
    },
  };
  return { transport, reads };
}

const bytesRead = (reads: Array<{ length: number }>) => reads.reduce((n, r) => n + r.length, 0);

// Each open book has its own blob: URLs, so two copies of the same book differ only in those.
const sameUrls = (html: string) => html.replace(/blob:[^"#]+/g, 'blob:<url>');

async function allChapters(book: Awaited<ReturnType<typeof openEpubFile>>): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < book.chapterCount; i++) out.push(sameUrls(await book.loadChapter(i)));
  return out;
}

describe('openEpubFile - size threshold', () => {
  it('uses a 16 MiB threshold', () => {
    expect(EPUB_WHOLE_FILE_MAX_BYTES).toBe(16 * MIB);
  });

  it('a file under the threshold is read whole, front to back, in one pass of bridge calls', async () => {
    const file = await buildEpub({ chapters: 6 });
    expect(file.length).toBeLessThan(EPUB_WHOLE_FILE_MAX_BYTES);
    const { transport, reads } = fakeTransport(file);

    const book = await openEpubFile('content://small.epub', 'small.epub', { transport });

    // Sequential chunks from offset 0 that exactly cover the file.
    let expectedOffset = 0;
    for (const read of reads) {
      expect(read.offset).toBe(expectedOffset);
      expectedOffset += read.length;
    }
    expect(expectedOffset).toBe(file.length);
    expect(book.chapterCount).toBe(6);

    // Loading chapters afterwards needs no further bridge calls.
    const before = reads.length;
    await allChapters(book);
    expect(reads.length).toBe(before);
  });

  it('asks the native side for the size only once on the whole-file path', async () => {
    const file = await buildEpub({ chapters: 4 });
    const { transport } = fakeTransport(file);
    const getSize = vi.spyOn(transport, 'getSize');
    await openEpubFile('u', 'x.epub', { transport });
    expect(getSize).toHaveBeenCalledTimes(1);
  });

  it('a file exactly at the threshold is read whole; one byte over is ranged', async () => {
    // Padding makes the file bigger than the 64 KiB tail read, so "ranged" is visible in the offsets.
    const file = await buildEpub({ chapters: 4, paddingBytes: 300 * 1024 });

    const atThreshold = fakeTransport(file);
    await openEpubFile('u', 'x.epub', { transport: atThreshold.transport, wholeFileMaxBytes: file.length });
    expect(atThreshold.reads[0].offset).toBe(0);
    expect(bytesRead(atThreshold.reads)).toBe(file.length);

    const overThreshold = fakeTransport(file);
    await openEpubFile('u', 'x.epub', { transport: overThreshold.transport, wholeFileMaxBytes: file.length - 1 });
    // Ranged: it starts from the tail (end-of-central-directory), not from offset 0.
    expect(overThreshold.reads[0].offset).toBeGreaterThan(0);
    expect(overThreshold.reads[0].offset + overThreshold.reads[0].length).toBe(file.length);
  });

  it('a large file is NOT read whole: opening and loading chapters reads a fraction of it', async () => {
    const file = await buildEpub({ chapters: 12, paddingBytes: 6 * MIB });
    expect(file.length).toBeGreaterThan(5 * MIB);
    const { transport, reads } = fakeTransport(file);

    const book = await openEpubFile('content://big.epub', 'big.epub', { transport, wholeFileMaxBytes: 1 * MIB });
    expect(book.chapterCount).toBe(12);
    const chapters = await allChapters(book);

    expect(chapters.join('')).toContain('CHAPTER_11_TEXT');
    // The padding is never referenced, so most of the file is never touched.
    expect(bytesRead(reads)).toBeLessThan(file.length / 2);
    // The first read is the tail (end-of-central-directory), not offset 0.
    expect(reads[0].offset).toBeGreaterThan(0);
    expect(reads[0].offset + reads[0].length).toBe(file.length);
    // Never reads past the end.
    for (const read of reads) expect(read.offset + read.length).toBeLessThanOrEqual(file.length);
  });

  it('big and small paths give identical books: title, count and every chapter, images included', async () => {
    const file = await buildEpub({ chapters: 12, missingSpineAt: 3 });
    const small = await openEpubFile('u', 'fallback.epub', { transport: fakeTransport(file).transport });
    const large = await openEpubFile('u', 'fallback.epub', { transport: fakeTransport(file).transport, wholeFileMaxBytes: 0 });

    expect(large.title).toBe(small.title);
    expect(small.title).toBe('Fixture Book');
    expect(large.chapterCount).toBe(small.chapterCount);
    expect(small.chapterCount).toBe(12); // the missing spine entry is dropped
    const a = await allChapters(small);
    const b = await allChapters(large);
    expect(b).toEqual(a);
    expect(a[0]).toMatch(/<img[^>]*src="blob:<url>"/); // images resolve the same way
    expect(a[1]).not.toContain('<img');
  });

  it('big and small paths give identical results with stored (uncompressed) chapters too', async () => {
    const file = await buildEpub({ chapters: 5, compression: 'STORE' });
    const small = await openEpubFile('u', 'x.epub', { transport: fakeTransport(file).transport });
    const large = await openEpubFile('u', 'x.epub', { transport: fakeTransport(file).transport, wholeFileMaxBytes: 0 });
    expect(await allChapters(large)).toEqual(await allChapters(small));
  });

  it('streams the same events from either path', async () => {
    const file = await buildEpub({ chapters: 6 });
    const events = async (wholeFileMaxBytes: number) => {
      const book = await openEpubFile('u', 'f.epub', { transport: fakeTransport(file).transport, wholeFileMaxBytes });
      const out: unknown[] = [];
      for await (const e of book.stream(2)) out.push(e.type === 'chapter' ? { ...e, html: sameUrls(e.html) } : e);
      return out;
    };
    const small = await events(EPUB_WHOLE_FILE_MAX_BYTES);
    const large = await events(0);
    expect(large).toEqual(small);
    expect(small[0]).toEqual({ type: 'title', title: 'Fixture Book' });
    expect(small[1]).toEqual({ type: 'total', count: 6 });
    expect(small).toHaveLength(2 + 4); // chapters 2..5
  });

  it('refuses a file over the book-size ceiling before reading anything', async () => {
    const { transport, reads } = fakeTransport(new Uint8Array(4));
    transport.getSize = async () => MAX_BOOK_BYTES + 1;
    await expect(openEpubFile('u', 'x.epub', { transport })).rejects.toBeInstanceOf(FileTooLargeError);
    expect(reads).toHaveLength(0);
  });

  it('a large file that is not a ZIP fails with a clear error, not a hang', async () => {
    const junk = new Uint8Array(3 * MIB).fill(7);
    const error = await openEpubFile('u', 'x.epub', { transport: fakeTransport(junk).transport, wholeFileMaxBytes: 1 * MIB }).catch((e) => e);
    expect(error).toBeInstanceOf(ZipFormatError);
    expect(error.message).toMatch(/Not a valid ZIP archive/);
  });

  it('a large EPUB with no container.xml fails the same way the small path does', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    const file = await zip.generateAsync({ type: 'uint8array' });
    const messages = await Promise.all(
      [EPUB_WHOLE_FILE_MAX_BYTES, 0].map((max) =>
        openEpubFile('u', 'x.epub', { transport: fakeTransport(file).transport, wholeFileMaxBytes: max }).catch((e: Error) => e.message),
      ),
    );
    expect(messages).toEqual(['Not a valid EPUB: missing META-INF/container.xml', 'Not a valid EPUB: missing META-INF/container.xml']);
  });
});

describe('openEpub - chapters load on demand', () => {
  async function countingArchive(options: FixtureOptions = {}) {
    const zip = await JSZip.loadAsync(await buildEpub(options));
    const inner = archiveFromJSZip(zip);
    const reads: string[] = [];
    const archive: EpubArchive = {
      has: (path) => inner.has(path),
      read: (path, max) => {
        reads.push(path);
        return inner.read(path, max);
      },
    };
    return { archive, reads };
  }

  it('opening reads only the container and the OPF - no chapter', async () => {
    const { archive, reads } = await countingArchive({ chapters: 50 });
    const book = await openEpub(archive, 'fallback');
    expect(book.chapterCount).toBe(50);
    expect(reads).toEqual(['META-INF/container.xml', 'OEBPS/content.opf']);
  });

  it('loading chapter N reads chapter N (and its images) and nothing before it', async () => {
    const { archive, reads } = await countingArchive({ chapters: 50 });
    const book = await openEpub(archive, 'fallback');
    reads.length = 0;

    const html = await book.loadChapter(40); // 40 % 4 === 0 so it has an image
    expect(html).toContain('CHAPTER_40_TEXT');
    expect(reads).toEqual(['OEBPS/text/c40.xhtml', 'OEBPS/img/pic.png']);
    expect(reads.some((r) => /c(0|1|2|39)\.xhtml$/.test(r))).toBe(false);
  });

  it('stream(startIndex) begins at that chapter and does not touch earlier ones', async () => {
    const { archive, reads } = await countingArchive({ chapters: 30 });
    const book = await openEpub(archive, 'fallback');
    reads.length = 0;

    const htmls: string[] = [];
    for await (const event of book.stream(27)) if (event.type === 'chapter') htmls.push(event.html);
    expect(htmls).toHaveLength(3);
    expect(htmls[0]).toContain('CHAPTER_27_TEXT');
    expect(reads.filter((r) => r.endsWith('.xhtml'))).toEqual([
      'OEBPS/text/c27.xhtml',
      'OEBPS/text/c28.xhtml',
      'OEBPS/text/c29.xhtml',
    ]);
  });

  it('chapter indexes skip spine entries that are missing from the archive (so saved positions keep lining up)', async () => {
    const { archive } = await countingArchive({ chapters: 6, missingSpineAt: 2 });
    const book = await openEpub(archive, 'fallback');
    expect(book.chapterCount).toBe(6);
    expect(await book.loadChapter(2)).toContain('CHAPTER_2_TEXT');
  });

  it('a chapter that cannot be read becomes an error placeholder instead of failing the book', async () => {
    const { archive } = await countingArchive({ chapters: 3 });
    const failing: EpubArchive = {
      has: archive.has,
      read: (path, max) => (path.endsWith('c1.xhtml') ? Promise.reject(new Error('boom')) : archive.read(path, max)),
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const book = await openEpub(failing, 'fallback');
    expect(await book.loadChapter(1)).toContain('chapter-error');
    expect(await book.loadChapter(2)).toContain('CHAPTER_2_TEXT');
    spy.mockRestore();
  });

  it('rejects an out-of-range chapter index', async () => {
    const { archive } = await countingArchive({ chapters: 3 });
    const book = await openEpub(archive, 'fallback');
    await expect(book.loadChapter(3)).rejects.toThrow(RangeError);
    await expect(book.loadChapter(-1)).rejects.toThrow(RangeError);
  });

  it('an EPUB whose spine has no readable chapters is rejected', async () => {
    const zip = new JSZip();
    zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>');
    zip.file('c.opf', '<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>');
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
    await expect(openEpub(archiveFromJSZip(loaded), 'x')).rejects.toThrow('No readable chapters found in this EPUB');
  });
});
