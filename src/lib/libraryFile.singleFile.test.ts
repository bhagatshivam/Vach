import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// A single file picked through "Add files", end to end, against an in-memory
// stand-in for the native LibraryFolder plugin that follows the Kotlin code's
// rules: pickFiles keeps only .epub/.pdf and persists a READ grant on each
// picked document; hasPersistedPermission is an exact match; statFile, getSize
// and readChunk all refuse a URI the app holds no grant for (validateGrantedUri:
// content:// scheme, and an exact grant on the document or a grant on an
// ancestor tree). Nothing here needs a phone, but it pins every JS-side step a
// single document goes through: pick -> store -> scan -> size -> chunked read ->
// open as EPUB / PDF.

if (typeof (Promise as unknown as { try?: unknown }).try !== 'function') {
  (Promise as unknown as { try: (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => Promise<unknown> }).try = (fn, ...args) =>
    new Promise((resolve) => resolve(fn(...args)));
}
vi.mock('./pdfWorkerEntry.ts?worker&url', () => ({
  default: pathToFileURL(`${process.cwd()}/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`).href,
}));

const saf = vi.hoisted(() => {
  const state = {
    /** What the system picker will return next: [uri, display name, bytes]. */
    picks: [] as Array<[string, string, Uint8Array]>,
    documents: new Map<string, { name: string; bytes: Uint8Array }>(),
    granted: new Set<string>(),
    trees: new Set<string>(),
    stored: new Map<string, string>(),
    chunkCalls: [] as Array<{ uri: string; offset: number; length: number }>,
  };
  /** validateGrantedUri from LibraryFolderPlugin.kt. */
  const validate = (uri: string): string | null => {
    if (!uri.startsWith('content://')) return `Unsupported URI scheme: ${uri.split(':')[0]}`;
    const ok = state.granted.has(uri) || [...state.trees].some((tree) => uri.startsWith(`${tree}/document/`));
    return ok ? null : 'This file is not covered by a granted permission';
  };
  const plugin = {
    async pickFiles() {
      const uris: string[] = [];
      for (const [uri, name, bytes] of state.picks) {
        state.documents.set(uri, { name, bytes });
        const ext = name.split('.').pop()?.toLowerCase();
        if (ext !== 'pdf' && ext !== 'epub') continue;
        state.granted.add(uri); // takePersistableUriPermission
        uris.push(uri);
      }
      state.picks = [];
      return { uris };
    },
    async pickFolder() {
      return { uri: 'content://docs/tree/books' };
    },
    async hasPersistedPermission({ uri }: { uri: string }) {
      return { granted: state.granted.has(uri) || state.trees.has(uri) };
    },
    async statFile({ uri }: { uri: string }) {
      const error = validate(uri);
      if (error) throw new Error(error);
      const doc = state.documents.get(uri);
      if (!doc) throw new Error('File is no longer accessible');
      return { file: { name: doc.name, uri, path: doc.name, size: doc.bytes.length } };
    },
    async scanFolder() {
      return { name: 'Books', files: [] };
    },
    async getSize({ uri }: { uri: string }) {
      const error = validate(uri);
      if (error) throw new Error(error);
      return { size: state.documents.get(uri)!.bytes.length };
    },
    async readChunk({ uri, offset, length }: { uri: string; offset: number; length: number }) {
      const error = validate(uri);
      if (error) throw new Error(error);
      state.chunkCalls.push({ uri, offset, length });
      const slice = state.documents.get(uri)!.bytes.subarray(offset, offset + length);
      return { base64: Buffer.from(slice).toString('base64'), length: slice.length };
    },
  };
  return { state, plugin };
});

vi.mock('@capacitor/core', () => ({ registerPlugin: () => saf.plugin }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: saf.state.stored.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void saf.state.stored.set(key, value),
    remove: async ({ key }: { key: string }) => void saf.state.stored.delete(key),
  },
}));

import { addFileSources, scanAllSources } from './libraryFolder';
import { createFileSource } from './fileBridge';
import { openEpubFile } from './epubFile';

async function tinyEpub(title: string, text: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/c0.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>${text}</p></body></html>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="u"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="u">x</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c0" href="c0.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c0"/></spine></package>`);
  return zip.generateAsync({ type: 'uint8array' });
}

async function tinyPdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([300, 300]).drawText(text, { x: 20, y: 200, size: 14, font });
  return pdf.save({ useObjectStreams: false });
}

beforeEach(() => {
  const { state } = saf;
  state.picks = [];
  state.documents.clear();
  state.granted.clear();
  state.trees.clear();
  state.stored.clear();
  state.chunkCalls = [];
});

describe('one file added through "Add files"', () => {
  it('is stored as a file source, listed by the scan, and its size and bytes come through the chunked bridge', async () => {
    const epub = await tinyEpub('Single Book', 'Only this file');
    saf.state.picks = [['content://docs/document/primary%3ABooks%2Fone.epub', 'one.epub', epub]];

    await addFileSources();
    const scan = await scanAllSources();
    expect(scan.failedSources).toEqual([]);
    expect(scan.sources).toEqual([{ source: { type: 'file', uri: 'content://docs/document/primary%3ABooks%2Fone.epub' }, displayName: 'one.epub' }]);
    expect(scan.files).toEqual([{ name: 'one.epub', uri: 'content://docs/document/primary%3ABooks%2Fone.epub', path: 'one.epub', size: epub.length }]);

    const source = await createFileSource(scan.files[0].uri);
    expect(source.size).toBe(epub.length);
    expect(await source.read(0, 4)).toEqual(epub.subarray(0, 4)); // "PK\3\4"
    expect(saf.state.chunkCalls.every((call) => call.uri === scan.files[0].uri)).toBe(true);
  });

  it('opens as an EPUB', async () => {
    const epub = await tinyEpub('Single Book', 'Only this file');
    saf.state.picks = [['content://docs/document/one', 'one.epub', epub]];
    await addFileSources();
    const { files } = await scanAllSources();

    const book = await openEpubFile(files[0].uri, 'fallback');
    expect(book.title).toBe('Single Book');
    expect(book.chapterCount).toBe(1);
    expect(await book.loadChapter(0)).toContain('Only this file');
  });

  it('opens as a PDF through the range transport', async () => {
    const pdf = await tinyPdf('SINGLE PDF TEXT');
    saf.state.picks = [['content://docs/document/two', 'two.pdf', pdf]];
    await addFileSources();
    const { files } = await scanAllSources();

    const { openPdf } = await import('./pdf');
    const source = await createFileSource(files[0].uri);
    const handle = await openPdf(source, 'two');
    const html: string[] = [];
    for await (const event of handle.streamChapters()) if (event.type === 'chapter') html.push(event.html);
    handle.destroy();
    expect(html.join('')).toContain('SINGLE PDF TEXT');
  });

  it('several picked at once are all kept; a file of another type is skipped; picking one again adds nothing', async () => {
    saf.state.picks = [
      ['content://docs/document/a', 'a.epub', await tinyEpub('A', 'a')],
      ['content://docs/document/b', 'b.pdf', await tinyPdf('b')],
      ['content://docs/document/c', 'notes.txt', new Uint8Array([1, 2, 3])],
    ];
    await addFileSources();
    expect((await scanAllSources()).files.map((f) => f.name).sort()).toEqual(['a.epub', 'b.pdf']);

    saf.state.picks = [['content://docs/document/a', 'a.epub', await tinyEpub('A', 'a')]];
    await addFileSources();
    expect((await scanAllSources()).sources).toHaveLength(2);
  });

  it('a picker that returns nothing (or only unsupported files) adds nothing', async () => {
    saf.state.picks = [['content://docs/document/c', 'notes.txt', new Uint8Array([1])]];
    await addFileSources();
    expect((await scanAllSources()).sources).toEqual([]);
  });
});

describe('the native permission rule a single document relies on', () => {
  it('an exact grant on the document is enough; a document that was never granted is refused by every call', async () => {
    const epub = await tinyEpub('Granted', 'x');
    saf.state.documents.set('content://docs/document/never', { name: 'never.epub', bytes: epub });
    await expect(createFileSource('content://docs/document/never')).rejects.toThrow('not covered by a granted permission');

    saf.state.stored.set('library_sources', JSON.stringify([{ type: 'file', uri: 'content://docs/document/never' }]));
    const scan = await scanAllSources();
    expect(scan.files).toEqual([]);
    expect(scan.failedSources).toHaveLength(1);
    expect(scan.failedSources[0].reason).toBe('permission-revoked');
  });

  it('a file:// or other non-content URI is refused', async () => {
    await expect(createFileSource('file:///data/data/app/secret.epub')).rejects.toThrow('Unsupported URI scheme');
  });
});
