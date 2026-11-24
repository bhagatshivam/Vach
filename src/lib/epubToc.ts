// The table of contents of an EPUB, read from the archive's own navigation
// document: EPUB 3's nav.xhtml (the <nav epub:type="toc">) or EPUB 2's
// toc.ncx, nav preferred when both exist. Only that one entry is read - no
// chapter is touched - and every entry is mapped to a spine index, the
// reader's own chapter numbering.
//
// A book with no usable TOC (nothing parsed, nothing that points into the
// spine) gets one "Section N" entry per chapter, built from the chapter count
// alone.

import type { EpubArchive } from './epub';
import { dirOf, fragmentOf, resolveRelativePath } from './epubPath';
import { cleanTocTitle, fallbackToc, type TocItem } from './toc';

const MAX_TOC_BYTES = 10 * 1024 * 1024;

export interface EpubTocSource {
  archive: Pick<EpubArchive, 'has' | 'read'>;
  /** Zip path of the EPUB 3 navigation document, if the OPF declares one. */
  navPath: string | null;
  /** Zip path of the EPUB 2 NCX, if the OPF declares one. */
  ncxPath: string | null;
  /** Zip path of each reader chapter (linear spine items that exist in the archive), by chapter index. */
  chapterPaths: readonly string[];
  /** Every spine item in OPF order, including non-linear ones and ones missing from the archive. */
  fullSpinePaths: readonly string[];
}

/** An entry as written in the book, before it is mapped onto the spine. */
export interface RawTocEntry {
  title: string;
  href: string | null;
  children: RawTocEntry[];
}

function localName(el: Element): string {
  return el.localName || el.tagName.split(':').pop() || el.tagName;
}

function childrenNamed(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((child) => localName(child) === name);
}

function parseMarkup(xml: string, type: 'application/xhtml+xml' | 'application/xml'): Document | null {
  const doc = new DOMParser().parseFromString(xml, type);
  return doc.querySelector('parsererror') ? null : doc;
}

function textOf(el: Element | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// ---- EPUB 3: nav.xhtml ------------------------------------------------------------

function epubTypeOf(el: Element): string {
  for (const attr of Array.from(el.attributes)) {
    if (attr.localName === 'type' || attr.name.endsWith(':type')) return attr.value;
  }
  return '';
}

function navList(listEl: Element): RawTocEntry[] {
  const entries: RawTocEntry[] = [];
  for (const li of childrenNamed(listEl, 'li')) {
    const link = childrenNamed(li, 'a')[0];
    const label = link ?? childrenNamed(li, 'span')[0];
    const nested = childrenNamed(li, 'ol').flatMap(navList);
    const title = textOf(label);
    const href = link?.getAttribute('href') ?? null;
    // An item with neither a link nor children says nothing.
    if (!href && nested.length === 0) continue;
    entries.push({ title, href: href && href.trim() ? href.trim() : null, children: nested });
  }
  return entries;
}

export function parseNavToc(xml: string): RawTocEntry[] {
  // The strict XML parse first (a real nav.xhtml); the lenient HTML one for the sloppy files that fail it.
  const doc = parseMarkup(xml, 'application/xhtml+xml') ?? new DOMParser().parseFromString(xml, 'text/html');
  const navs = Array.from(doc.getElementsByTagName('*')).filter((el) => localName(el) === 'nav');
  const toc = navs.find((nav) => epubTypeOf(nav).split(/\s+/).includes('toc')) ?? navs.find((nav) => !/landmarks|page-list/.test(epubTypeOf(nav)));
  if (!toc) return [];
  const list = Array.from(toc.getElementsByTagName('*')).find((el) => localName(el) === 'ol');
  return list ? navList(list) : [];
}

// ---- EPUB 2: toc.ncx ---------------------------------------------------------------

function ncxPoints(parent: Element): RawTocEntry[] {
  return childrenNamed(parent, 'navPoint').map((point) => {
    const label = childrenNamed(point, 'navLabel')[0];
    const content = childrenNamed(point, 'content')[0];
    return {
      title: textOf(childrenNamed(label ?? point, 'text')[0]),
      href: content?.getAttribute('src')?.trim() || null,
      children: ncxPoints(point),
    };
  });
}

export function parseNcxToc(xml: string): RawTocEntry[] {
  const doc = parseMarkup(xml, 'application/xml');
  if (!doc) return [];
  const navMap = Array.from(doc.getElementsByTagName('*')).find((el) => localName(el) === 'navMap');
  return navMap ? ncxPoints(navMap) : [];
}

// ---- Mapping onto the spine -----------------------------------------------------------

/**
 * Turns raw entries into TocItems: each href is resolved against the file it was
 * written in, then mapped to a spine index. An entry pointing at a spine item
 * the reader does not show (non-linear, or listed but missing) opens the nearest
 * chapter after it (else before it); one pointing outside the spine altogether
 * is dropped, unless it has entries beneath it, in which case it opens the first
 * of those. Duplicates are kept (two entries may open the same chapter).
 */
export function resolveTocEntries(raw: readonly RawTocEntry[], tocFilePath: string, chapterPaths: readonly string[], fullSpinePaths: readonly string[]): TocItem[] {
  const baseDir = dirOf(tocFilePath);
  const chapterByPath = new Map<string, number>();
  chapterPaths.forEach((path, index) => {
    if (!chapterByPath.has(path)) chapterByPath.set(path, index);
  });
  const fullIndexByPath = new Map<string, number>();
  fullSpinePaths.forEach((path, index) => {
    if (!fullIndexByPath.has(path)) fullIndexByPath.set(path, index);
  });

  function chapterFor(path: string): number | null {
    const direct = chapterByPath.get(path);
    if (direct !== undefined) return direct;
    const at = fullIndexByPath.get(path);
    if (at === undefined) return null;
    for (let i = at + 1; i < fullSpinePaths.length; i++) {
      const found = chapterByPath.get(fullSpinePaths[i]);
      if (found !== undefined) return found;
    }
    for (let i = at - 1; i >= 0; i--) {
      const found = chapterByPath.get(fullSpinePaths[i]);
      if (found !== undefined) return found;
    }
    return null;
  }

  function build(entries: readonly RawTocEntry[], depth: number): TocItem[] {
    const out: TocItem[] = [];
    for (const entry of entries) {
      const children = build(entry.children, depth + 1);
      let chapterIndex: number | null = null;
      let fragment: string | undefined;
      if (entry.href) {
        const path = resolveRelativePath(baseDir, entry.href);
        // An href that is only a fragment ("#top") means the TOC file itself, which is never a chapter.
        chapterIndex = path ? chapterFor(path) : null;
        // The fragment names a spot in the file the entry pointed at; if it was redirected to a neighbour, it no longer applies.
        if (chapterIndex !== null && chapterByPath.get(path) === chapterIndex) fragment = fragmentOf(entry.href);
      }
      if (chapterIndex === null) {
        const first = children[0];
        if (!first) continue;
        chapterIndex = first.chapterIndex;
        fragment = first.fragment;
      }
      out.push({ id: '', title: cleanTocTitle(entry.title, chapterIndex), chapterIndex, fragment, depth, children });
    }
    return out;
  }

  const items = build(raw, 0);
  let counter = 0;
  const number = (list: TocItem[]) => {
    for (const item of list) {
      item.id = `t${counter++}`;
      number(item.children);
    }
  };
  number(items);
  return items;
}

async function readText(archive: Pick<EpubArchive, 'has' | 'read'>, path: string | null): Promise<string | null> {
  if (!path || !archive.has(path)) return null;
  try {
    return new TextDecoder().decode(await archive.read(path, MAX_TOC_BYTES));
  } catch (err) {
    console.error('[epub] could not read the table of contents', path, err);
    return null;
  }
}

/**
 * Loads the table of contents: nav.xhtml, else toc.ncx, else one "Section N"
 * per chapter. Reads only the navigation file(s). Never throws.
 */
export async function loadEpubToc(source: EpubTocSource): Promise<TocItem[]> {
  const { archive, navPath, ncxPath, chapterPaths, fullSpinePaths } = source;
  const candidates: Array<{ path: string | null; parse: (xml: string) => RawTocEntry[] }> = [
    { path: navPath, parse: parseNavToc },
    { path: ncxPath, parse: parseNcxToc },
  ];
  for (const { path, parse } of candidates) {
    const xml = await readText(archive, path);
    if (xml === null || path === null) continue;
    try {
      const items = resolveTocEntries(parse(xml), path, chapterPaths, fullSpinePaths);
      if (items.length > 0) return items;
    } catch (err) {
      console.error('[epub] malformed table of contents', path, err);
    }
  }
  return fallbackToc(chapterPaths.length);
}
