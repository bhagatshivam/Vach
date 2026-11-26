// A Word document as a "book": the converted HTML is cut into virtual chapters, which then flow through exactly the
// pipeline an EPUB's chapters do - lazy loading, chapter-relative saved positions, the Contents drawer, tables, the
// image store and the lightbox - with no special cases in the reader.
//
//   headings:     a chapter starts at each <h1> / <h2>; the TOC is built from <h1>-<h3>
//   no headings:  chapters are cut at paragraph boundaries about every 2,500-3,000 words, titled "Section N"
//   links:        every id is kept as a data-vach-anchor (epub.ts); internal links (footnotes, endnotes,
//                 cross-references) become tappable spans that name the chapter and anchor they point to
//
// The converter (mammoth) is not imported here: it runs in a Worker (docxClient.ts) and hands back plain data.

import { ImageStore, type RegisteredImage } from './imageProcessor';
import { sanitizeChapterHtml, type EpubBook } from './epub';
import { LINK_ATTR, cleanTocTitle, fallbackToc, type TocItem } from './toc';
import { DOCX_IMAGE_SCHEME, type DocxConversion } from './docxTypes';
import type { DocxConverter } from './docxClient';
import type { ParseEvent } from './epub';

/** A heading-less document is cut into chunks of about this many words (never mid-paragraph). */
export const TARGET_WORDS_PER_SECTION = 2750;
/** A final chunk smaller than this share of a section is folded into the one before it. */
const MIN_LAST_SECTION_SHARE = 0.4;
const MAX_LINK_TARGET_LENGTH = 200;
const EMPTY_DOCUMENT_HTML = '<p>This document is empty.</p>';

export interface DocxSlice {
  title: string;
  html: string;
  words: number;
}

export interface DocxStructure {
  chapters: DocxSlice[];
  /** The headings as a tree; empty when the document has none (the reader then lists "Section N"). */
  toc: TocItem[];
  /** Which chapter each id (heading bookmark, footnote, endnote...) lives in. */
  anchors: ReadonlyMap<string, number>;
  hasHeadings: boolean;
}

const countWords = (text: string): number => (text.match(/\S+/g) ?? []).length;
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** An empty <a id> / <a name> bookmark: it marks a spot, and belongs with what follows it. */
function isBookmarkMarker(node: Node): boolean {
  return node.nodeType === 1 && (node as Element).tagName === 'A' && !(node.textContent ?? '').trim() && ((node as Element).hasAttribute('id') || (node as Element).hasAttribute('name'));
}

function hasVisibleContent(nodes: readonly Node[]): boolean {
  return nodes.some((node) => (node.textContent ?? '').trim() !== '' || (node.nodeType === 1 && ((node as Element).tagName === 'IMG' || (node as Element).querySelector('img') !== null)));
}

function idsIn(node: Node): string[] {
  if (node.nodeType !== 1) return [];
  const el = node as Element;
  const ids: string[] = [];
  const own = el.getAttribute('id') ?? (el.tagName === 'A' ? el.getAttribute('name') : null);
  if (own) ids.push(own);
  for (const inner of Array.from(el.querySelectorAll('[id], a[name]'))) {
    const id = inner.getAttribute('id') ?? inner.getAttribute('name');
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Cuts converted HTML into chapters and works out the TOC and where each anchor lives.
 * `documentTitle` names text that comes before the first heading.
 */
export function sliceDocxHtml(html: string, documentTitle: string, targetWords = TARGET_WORDS_PER_SECTION): DocxStructure {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = Array.from(doc.body.childNodes).filter((node) => node.nodeType === 1 || (node.textContent ?? '').trim() !== '');

  const hasHeadings = nodes.some((node) => node.nodeType === 1 && /^H[12]$/.test((node as Element).tagName));
  const groups: Node[][] = [];
  const titles: string[] = [];
  const toc: TocItem[] = [];
  // Whether there is a chapter of text before the first heading.
  let hasPreface = false;

  if (hasHeadings) {
    let current: Node[] = [];
    let currentTitle = documentTitle;
    let seenHeading = false;
    const flush = () => {
      if (current.length === 0) return;
      // Text before the first heading is kept only if there is something to read in it.
      if (!seenHeading && !hasVisibleContent(current)) {
        current = [];
        return;
      }
      if (!seenHeading) hasPreface = true;
      groups.push(current);
      titles.push(currentTitle);
      current = [];
    };
    for (const node of nodes) {
      if (node.nodeType === 1 && /^H[12]$/.test((node as Element).tagName)) {
        // Bookmarks sitting just before a heading belong to it, not to the chapter that ends here.
        const carried: Node[] = [];
        while (current.length > 0 && isBookmarkMarker(current[current.length - 1])) carried.unshift(current.pop()!);
        flush();
        seenHeading = true;
        current = [...carried, node];
        currentTitle = squash(node.textContent ?? '');
      } else {
        current.push(node);
      }
    }
    flush();
  } else {
    // No headings: cut between top-level blocks once a chunk has about `targetWords` words.
    let current: Node[] = [];
    let words = 0;
    for (const node of nodes) {
      current.push(node);
      words += countWords(node.textContent ?? '');
      // A chunk ends on the block that takes it past the target, so a bookmark (no words) before the next block
      // always starts the next chunk and stays with what it marks.
      if (words >= targetWords) {
        groups.push(current);
        current = [];
        words = 0;
      }
    }
    if (current.length > 0) {
      if (groups.length > 0 && words < targetWords * MIN_LAST_SECTION_SHARE) groups[groups.length - 1].push(...current);
      else groups.push(current);
    }
  }

  // A document with nothing in it still opens, on a message.
  if (groups.length === 0 || !groups.some(hasVisibleContent)) {
    return { chapters: [{ title: documentTitle, html: EMPTY_DOCUMENT_HTML, words: 0 }], toc: [], anchors: new Map(), hasHeadings: false };
  }

  // ---- anchors, the TOC's H3 targets, then serialise -----------------------------------------------------------------
  const anchors = new Map<string, number>();
  const stack: Array<{ level: number; item: TocItem }> = [];
  let tocCounter = 0;
  let headingSerial = 0;

  const addTocItem = (title: string, chapterIndex: number, level: number, fragment?: string) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    const item: TocItem = { id: `t${tocCounter++}`, title: cleanTocTitle(title, chapterIndex), chapterIndex, fragment, depth: stack.length, children: [] };
    if (stack.length > 0) stack[stack.length - 1].item.children.push(item);
    else toc.push(item);
    stack.push({ level, item });
  };

  const chapters: DocxSlice[] = groups.map((group, index) => {
    let words = 0;
    for (const node of group) {
      words += countWords(node.textContent ?? '');
      if (node.nodeType === 1 && hasHeadings) {
        const el = node as Element;
        if (/^H[123]$/.test(el.tagName)) {
          const level = Number(el.tagName[1]);
          const isChapterStart = level <= 2;
          // A third-level heading is somewhere inside its chapter, so it gets an anchor to scroll to.
          let fragment: string | undefined;
          if (!isChapterStart) {
            fragment = `vach-heading-${headingSerial++}`;
            el.setAttribute('id', fragment);
          }
          addTocItem(squash(el.textContent ?? ''), index, level, fragment);
        }
      }
      for (const id of idsIn(node)) if (!anchors.has(id)) anchors.set(id, index);
    }
    return { title: hasHeadings ? titles[index] : `Section ${index + 1}`, html: group.map((node) => (node.nodeType === 1 ? (node as Element).outerHTML : (node.textContent ?? ''))).join(''), words };
  });

  // Text before the first heading is a chapter of its own and gets a TOC entry too.
  if (hasHeadings && hasPreface) {
    toc.unshift({ id: 'preface', title: cleanTocTitle(chapters[0].title, 0), chapterIndex: 0, depth: 0, children: [] });
  }
  return { chapters, toc: hasHeadings ? toc : [], anchors, hasHeadings };
}

/**
 * Turns a chapter's internal links into spans a tap can act on: `<a href="#footnote-2">` becomes
 * `<span data-vach-link="footnote-2">` when that id exists somewhere in the document, and is left to be unwrapped to
 * plain text (a link to nowhere is not a link) when it does not. Every other link is plain text too: the reader never
 * leaves the document.
 */
export function linkifyInternalLinks(doc: Document, anchors: ReadonlyMap<string, number>): void {
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    let target: string | null = null;
    if (href.startsWith('#')) {
      try {
        target = decodeURIComponent(href.slice(1));
      } catch {
        target = href.slice(1);
      }
    }
    if (target && target.length <= MAX_LINK_TARGET_LENGTH && anchors.has(target)) {
      const span = doc.createElement('span');
      span.setAttribute(LINK_ATTR, target);
      // A link can also be a target (a footnote number is both): its own id / name moves to the span.
      const own = a.getAttribute('id') ?? a.getAttribute('name');
      if (own) span.setAttribute('id', own);
      while (a.firstChild) span.appendChild(a.firstChild);
      a.replaceWith(span);
    }
  }
}

// ---- the book ----------------------------------------------------------------------------------------------------------

export interface OpenDocxOptions {
  /** Runs the converter (a Worker in the app; the converter itself in tests). */
  convert: DocxConverter;
  signal?: AbortSignal;
}

/**
 * Converts a .docx and returns it as a book the reader opens like an EPUB.
 * Memory: the pictures' original bytes are kept for the life of the book (a Word file is small, and the lightbox
 * re-opens the original at full detail from them); everything else is the converted text.
 */
export async function openDocx(bytes: ArrayBuffer, fallbackTitle: string, options: OpenDocxOptions): Promise<EpubBook> {
  const conversion: DocxConversion = await options.convert(bytes, options.signal);
  const title = conversion.title ?? fallbackTitle;
  const structure = sliceDocxHtml(conversion.html, title);
  const { chapters, anchors } = structure;

  const images = new ImageStore();
  const pictures = new Map(conversion.images.map((image) => [`${DOCX_IMAGE_SCHEME}${image.id}`, image]));
  const imageCache = new Map<string, RegisteredImage | null>();

  async function resolveImage(path: string): Promise<RegisteredImage | null> {
    if (imageCache.has(path)) return imageCache.get(path) ?? null;
    const picture = pictures.get(path);
    if (!picture) {
      imageCache.set(path, null);
      return null;
    }
    // The store keeps a way to read the original again (the downscale, the lightbox): here, the bytes themselves.
    const info = images.register(path, picture.bytes, picture.contentType, { read: async () => picture.bytes });
    imageCache.set(path, info);
    return info;
  }
  const registerInline = (inlineBytes: Uint8Array, mediaType: string, key: string): RegisteredImage => images.register(key, inlineBytes, mediaType, { read: async () => inlineBytes });

  async function loadChapter(index: number): Promise<string> {
    const slice = chapters[index];
    if (slice === undefined) throw new RangeError(`No chapter ${index} (this document has ${chapters.length})`);
    try {
      return await sanitizeChapterHtml(slice.html, '', resolveImage, registerInline, (doc) => linkifyInternalLinks(doc, anchors));
    } catch (err) {
      console.error('[docx] failed to prepare section', index, err);
      return '<p class="chapter-error">[This section could not be loaded]</p>';
    }
  }

  const tocItems = structure.toc.length > 0 ? structure.toc : fallbackToc(chapters.length);

  return {
    title,
    chapterCount: chapters.length,
    loadChapter,
    toc: async () => tocItems,
    chapterWeights: chapters.map((chapter) => Math.max(1, chapter.html.length)),
    resolveLink: (anchorId) => {
      const chapterIndex = anchors.get(anchorId);
      return chapterIndex === undefined ? null : { chapterIndex, fragment: anchorId };
    },
    images,
    close: () => {
      images.revokeAll();
      imageCache.clear();
      pictures.clear();
    },
    async *stream(startIndex = 0): AsyncGenerator<ParseEvent> {
      yield { type: 'title', title };
      yield { type: 'total', count: chapters.length };
      for (let i = Math.max(0, startIndex); i < chapters.length; i++) yield { type: 'chapter', html: await loadChapter(i) };
    },
  };
}
