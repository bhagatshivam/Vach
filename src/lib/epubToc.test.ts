import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { archiveFromJSZip, openEpub, type EpubArchive } from './epub';
import { loadEpubToc, parseNavToc, parseNcxToc, resolveTocEntries, type RawTocEntry } from './epubToc';
import { flattenToc } from './toc';

// Real EPUBs built in memory and opened through the real openEpub: every TOC path, and that none of it reads a chapter.

interface Fixture {
  chapters?: string[]; // paths under OEBPS/
  nonLinear?: string[]; // extra spine items marked linear="no"
  nav?: string | null; // nav.xhtml body (the <nav> markup), or null for no nav
  navPath?: string; // where the nav lives under OEBPS/
  ncx?: string | null; // toc.ncx full xml
  ncxViaSpineAttr?: boolean;
  extraManifest?: string; // raw items appended to the manifest
  opfDir?: string;
}

const NAV_NS = 'xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"';

async function build(f: Fixture = {}): Promise<{ archive: EpubArchive; reads: string[]; bytes: Uint8Array }> {
  const chapters = f.chapters ?? ['c0.xhtml', 'c1.xhtml', 'c2.xhtml', 'c3.xhtml'];
  const navPath = f.navPath ?? 'nav.xhtml';
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');

  const manifest: string[] = [];
  const spine: string[] = [];
  chapters.forEach((path, i) => {
    manifest.push(`<item id="c${i}" href="${path}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i}"/>`);
    zip.file(`OEBPS/${decodeURIComponent(path)}`, `<html><body><h2>Chapter ${i}</h2><p>BODY_${i}</p></body></html>`);
  });
  (f.nonLinear ?? []).forEach((path, i) => {
    manifest.push(`<item id="n${i}" href="${path}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="n${i}" linear="no"/>`);
    zip.file(`OEBPS/${path}`, '<html><body><p>side</p></body></html>');
  });
  if (f.nav !== null && f.nav !== undefined) {
    manifest.push(`<item id="nav" href="${navPath}" media-type="application/xhtml+xml" properties="nav"/>`);
    zip.file(`OEBPS/${navPath}`, `<?xml version="1.0"?><html ${NAV_NS}><head><title>Contents</title></head><body>${f.nav}</body></html>`);
  }
  if (f.ncx) {
    manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
    zip.file('OEBPS/toc.ncx', f.ncx);
  }
  if (f.extraManifest) manifest.push(f.extraManifest);
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest>${manifest.join('')}</manifest><spine${f.ncxViaSpineAttr ? ' toc="ncx"' : ''}>${spine.join('')}</spine></package>`,
  );
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const inner = archiveFromJSZip(await JSZip.loadAsync(bytes));
  const reads: string[] = [];
  const archive: EpubArchive = {
    has: (p) => inner.has(p),
    read: (p, max) => {
      reads.push(p);
      return inner.read(p, max);
    },
    sizeOf: inner.sizeOf,
  };
  return { archive, reads, bytes };
}

const navOf = (list: string) => `<nav epub:type="toc"><h1>Contents</h1>${list}</nav>`;
const summary = (items: ReturnType<typeof flattenToc>) => items.map((i) => `${'-'.repeat(i.depth)}${i.title}>${i.chapterIndex}${i.fragment ? '#' + i.fragment : ''}`);

describe('EPUB 3 nav.xhtml', () => {
  it('reads a nested nav and maps every entry to its spine index, with fragments', async () => {
    const { archive } = await build({
      nav: navOf(`<ol>
        <li><a href="c0.xhtml">Part One</a><ol>
          <li><a href="c1.xhtml">Chapter 1</a></li>
          <li><a href="c1.xhtml#sec2">Section 1.2</a></li>
        </ol></li>
        <li><a href="c2.xhtml#top">Chapter 2</a></li>
        <li><span>Heading without a link</span><ol><li><a href="c3.xhtml">Chapter 3</a></li></ol></li>
      </ol>`),
    });
    const book = await openEpub(archive, 'x');
    const toc = await book.toc();
    expect(summary(flattenToc(toc))).toEqual(['Part One>0', '-Chapter 1>1', '-Section 1.2>1#sec2', 'Chapter 2>2#top', 'Heading without a link>3', '-Chapter 3>3']);
    expect(toc[0].children).toHaveLength(2);
    expect(new Set(flattenToc(toc).map((i) => i.id)).size).toBe(6);
  });

  it('uses the toc nav, not landmarks or page-list', async () => {
    const { archive } = await build({
      nav: `<nav epub:type="landmarks"><ol><li><a href="c3.xhtml">Start</a></li></ol></nav>${navOf('<ol><li><a href="c0.xhtml">Real</a></li></ol>')}<nav epub:type="page-list"><ol><li><a href="c2.xhtml">p1</a></li></ol></nav>`,
    });
    expect(summary(flattenToc(await (await openEpub(archive, 'x')).toc()))).toEqual(['Real>0']);
  });

  it('a nav that is not well-formed XML still parses (as HTML)', async () => {
    const toc = parseNavToc('<html><body><nav epub:type="toc"><ol><li><a href="c0.xhtml">One<br></a></li><li><a href="c1.xhtml">Two</a></li></ol></nav></body></html>&nbsp;<unclosed');
    expect(toc.map((e) => [e.title, e.href])).toEqual([['One', 'c0.xhtml'], ['Two', 'c1.xhtml']]);
  });

  it('resolves hrefs against the nav file, not the OPF: a nav in a subfolder, "../" and percent-encoded names', async () => {
    const { archive } = await build({
      chapters: ['text/c0.xhtml', 'text/My%20Chapter.xhtml', 'text/c2.xhtml'],
      navPath: 'nav/nav.xhtml',
      nav: navOf(`<ol>
        <li><a href="../text/c0.xhtml">Zero</a></li>
        <li><a href="../text/My%20Chapter.xhtml#a%20b">Spaced</a></li>
        <li><a href="./../text/c2.xhtml">Two</a></li>
        <li><a href="../text/My Chapter.xhtml">Raw space</a></li>
      </ol>`),
    });
    const toc = await (await openEpub(archive, 'x')).toc();
    expect(summary(flattenToc(toc))).toEqual(['Zero>0', 'Spaced>1#a b', 'Two>2', 'Raw space>1']);
  });
});

describe('EPUB 2 toc.ncx', () => {
  const ncx = (points: string) => `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${points}</navMap></ncx>`;
  const point = (n: number, label: string, src: string, children = '') => `<navPoint id="p${n}" playOrder="${n}"><navLabel><text>${label}</text></navLabel><content src="${src}"/>${children}</navPoint>`;

  it('reads nested navPoints', async () => {
    const { archive } = await build({ nav: null, ncx: ncx(point(1, 'Book One', 'c0.xhtml', point(2, 'Ch 1', 'c1.xhtml') + point(3, 'Ch 2', 'c2.xhtml#x')) + point(4, 'Book Two', 'c3.xhtml')) });
    const toc = await (await openEpub(archive, 'x')).toc();
    expect(summary(flattenToc(toc))).toEqual(['Book One>0', '-Ch 1>1', '-Ch 2>2#x', 'Book Two>3']);
  });

  it('finds the NCX through <spine toc="...">', async () => {
    const { archive } = await build({
      nav: null,
      ncxViaSpineAttr: true,
      ncx: ncx(point(1, 'Only', 'c1.xhtml')),
    });
    expect(summary(flattenToc(await (await openEpub(archive, 'x')).toc()))).toEqual(['Only>1']);
  });

  it('parseNcxToc gives nothing for malformed XML', () => {
    expect(parseNcxToc('<ncx><navMap><navPoint>')).toEqual([]);
    expect(parseNcxToc('not xml at all')).toEqual([]);
  });
});

describe('both nav and NCX / neither', () => {
  it('prefers the nav when both exist', async () => {
    const { archive } = await build({
      nav: navOf('<ol><li><a href="c0.xhtml">From nav</a></li></ol>'),
      ncx: '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>From ncx</text></navLabel><content src="c1.xhtml"/></navPoint></navMap></ncx>',
    });
    expect(summary(flattenToc(await (await openEpub(archive, 'x')).toc()))).toEqual(['From nav>0']);
  });

  it('falls back to the NCX when the nav yields nothing usable', async () => {
    const { archive } = await build({
      nav: navOf('<ol><li><a href="nowhere.xhtml">Lost</a></li></ol>'),
      ncx: '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>Rescued</text></navLabel><content src="c1.xhtml"/></navPoint></navMap></ncx>',
    });
    expect(summary(flattenToc(await (await openEpub(archive, 'x')).toc()))).toEqual(['Rescued>1']);
  });

  it('no TOC at all: one "Section N" per chapter, built without reading any chapter', async () => {
    const { archive, reads } = await build({ nav: null, ncx: null });
    const book = await openEpub(archive, 'x');
    reads.length = 0;
    const toc = await book.toc();
    expect(summary(toc)).toEqual(['Section 1>0', 'Section 2>1', 'Section 3>2', 'Section 4>3']);
    expect(reads).toEqual([]);
  });

  it('an unreadable or empty nav also ends in the fallback', async () => {
    const { archive } = await build({ nav: navOf('<ol></ol>') });
    expect((await (await openEpub(archive, 'x')).toc()).map((i) => i.title)).toEqual(['Section 1', 'Section 2', 'Section 3', 'Section 4']);
  });
});

describe('hrefs that do not line up with the spine', () => {
  it('a non-linear spine item maps to the nearest chapter after it; a file outside the spine is dropped', async () => {
    const { archive } = await build({
      nonLinear: ['notes.xhtml'],
      extraManifest: '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>',
      nav: navOf(`<ol>
        <li><a href="c0.xhtml">Zero</a></li>
        <li><a href="notes.xhtml">Notes</a></li>
        <li><a href="cover.xhtml">Cover (not in spine)</a></li>
        <li><a href="ghost.xhtml">Ghost</a></li>
        <li><a href="c2.xhtml">Two</a></li>
      </ol>`),
    });
    const toc = await (await openEpub(archive, 'x')).toc();
    // "notes" is the last spine item: nothing follows it, so it opens the nearest chapter before it (c3).
    expect(summary(flattenToc(toc))).toEqual(['Zero>0', 'Notes>3', 'Two>2']);
  });

  it('an entry outside the spine that has children opens its first child', () => {
    const raw: RawTocEntry[] = [{ title: 'Part', href: 'missing.xhtml', children: [{ title: 'Ch', href: 'c1.xhtml#f', children: [] }] }];
    const items = resolveTocEntries(raw, 'OEBPS/nav.xhtml', ['OEBPS/c0.xhtml', 'OEBPS/c1.xhtml'], ['OEBPS/c0.xhtml', 'OEBPS/c1.xhtml']);
    expect(summary(flattenToc(items))).toEqual(['Part>1#f', '-Ch>1#f']);
  });

  it('a redirected entry does not keep a fragment that belonged to another file', () => {
    const items = resolveTocEntries(
      [{ title: 'Side', href: 'n.xhtml#x', children: [] }],
      'OEBPS/nav.xhtml',
      ['OEBPS/c0.xhtml', 'OEBPS/c1.xhtml'],
      ['OEBPS/c0.xhtml', 'OEBPS/n.xhtml', 'OEBPS/c1.xhtml'],
    );
    expect(items).toHaveLength(1);
    expect(items[0].chapterIndex).toBe(1);
    expect(items[0].fragment).toBeUndefined();
  });

  it('duplicates are kept, empty titles become "Section N", fragment-only and empty hrefs are dropped', async () => {
    const { archive } = await build({
      nav: navOf(`<ol>
        <li><a href="c1.xhtml">Same</a></li>
        <li><a href="c1.xhtml">Same</a></li>
        <li><a href="c2.xhtml">   </a></li>
        <li><a href="#top">Self link</a></li>
        <li><a href="">Empty href</a></li>
        <li><a>No href</a></li>
        <li><a href="c3.xhtml%ZZbad">Bad escape</a></li>
      </ol>`),
    });
    const toc = await (await openEpub(archive, 'x')).toc();
    expect(summary(flattenToc(toc))).toEqual(['Same>1', 'Same>1', 'Section 3>2']);
  });

  it('survives absurd input without throwing', () => {
    const weird: RawTocEntry[] = [
      { title: 'x'.repeat(10000), href: '../../../../../etc/passwd', children: [] },
      { title: 'y', href: 'c0.xhtml#%E0%A4%A', children: [] },
    ];
    expect(() => resolveTocEntries(weird, 'OEBPS/nav.xhtml', ['OEBPS/c0.xhtml'], ['OEBPS/c0.xhtml'])).not.toThrow();
  });
});

describe('the TOC is cheap: nothing but the nav/ncx is read', () => {
  it('opening reads container + OPF; toc() reads only the nav; no chapter is ever read', async () => {
    const { archive, reads } = await build({ nav: navOf('<ol><li><a href="c0.xhtml">A</a></li><li><a href="c3.xhtml">D</a></li></ol>') });
    const book = await openEpub(archive, 'x');
    await book.toc();
    await book.toc(); // cached
    expect(reads).toEqual(['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml']);
    expect(reads.some((p) => /c\d\.xhtml$/.test(p))).toBe(false);
  });

  it('a nav that cannot be read falls back without touching chapters, and never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { archive, reads } = await build({ nav: navOf('<ol><li><a href="c0.xhtml">A</a></li></ol>') });
    const broken: EpubArchive = { ...archive, read: (p, m) => (p.endsWith('nav.xhtml') ? Promise.reject(new Error('corrupt')) : archive.read(p, m)) };
    const book = await openEpub(broken, 'x');
    reads.length = 0;
    expect((await book.toc()).map((i) => i.title)).toEqual(['Section 1', 'Section 2', 'Section 3', 'Section 4']);
    expect(reads.some((p) => /c\d\.xhtml$/.test(p))).toBe(false);
    vi.restoreAllMocks();
  });

  it('loadEpubToc on its own reads nothing when there is no nav or ncx path', async () => {
    const { archive, reads } = await build({ nav: null });
    const toc = await loadEpubToc({ archive, navPath: null, ncxPath: null, chapterPaths: ['a', 'b'], fullSpinePaths: ['a', 'b'] });
    expect(toc).toHaveLength(2);
    expect(reads).toEqual([]);
  });
});

describe('chapter weights', () => {
  it('come from the ZIP index (uncompressed sizes) without reading any chapter', async () => {
    const { archive, reads } = await build({ nav: null });
    const book = await openEpub(archive, 'x');
    expect(book.chapterWeights).toHaveLength(4);
    for (const w of book.chapterWeights!) expect(w).toBeGreaterThan(40);
    expect(reads).toEqual(['META-INF/container.xml', 'OEBPS/content.opf']);
  });

  it('are null when the archive cannot give sizes', async () => {
    const { archive } = await build({ nav: null });
    const book = await openEpub({ has: archive.has, read: archive.read }, 'x');
    expect(book.chapterWeights).toBeNull();
  });

  it('track real sizes: a longer chapter weighs more', async () => {
    const zip = new JSZip();
    zip.file('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="o.opf" media-type="x"/></rootfiles></container>');
    zip.file('o.opf', '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>');
    zip.file('a.xhtml', `<html><body>${'<p>short</p>'}</body></html>`);
    zip.file('b.xhtml', `<html><body>${'<p>much longer chapter text</p>'.repeat(200)}</body></html>`);
    const book = await openEpub(archiveFromJSZip(await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }))), 'x');
    const [a, b] = book.chapterWeights!;
    expect(b).toBeGreaterThan(a * 50);
  });
});
