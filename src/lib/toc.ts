// One table-of-contents model for every format, plus the pure logic the
// drawer needs: which entry is current, whether the tree is deep enough to
// need collapsing, and overall book progress weighted by chapter size.
//
// Each format has its own loader that produces a TocItem[]: epubToc.ts for EPUB
// (nav.xhtml / toc.ncx), pdf.ts for a PDF outline. A future format (.docx
// headings) only has to produce the same shape - nothing here knows about any
// of them.

/**
 * The attribute a chapter's own ids are kept under (see epub.ts), so a TOC
 * entry's fragment can be found in the mounted chapter. Lives here so the
 * reader can use it without loading the EPUB parser.
 */
export const ANCHOR_ATTR = 'data-vach-anchor';

/**
 * The attribute an internal link (a Word footnote or cross-reference) carries in a mounted chapter: the id it points
 * to. A tap on such an element jumps to that id's chapter and anchor (the book's resolveLink).
 */
export const LINK_ATTR = 'data-vach-link';

export interface TocItem {
  /** Unique within one book's TOC (document order), for React keys and expand state. */
  id: string;
  /** What the reader shows; never empty. */
  title: string;
  /**
   * The chapter this entry opens, in the reader's own numbering: the EPUB
   * spine index (the `chapterIndex` of a saved position) or the PDF page
   * index, 0-based.
   */
  chapterIndex: number;
  /** An id inside that chapter to scroll to, when the book names one. */
  fragment?: string;
  /** 0 for a top-level entry. */
  depth: number;
  children: TocItem[];
}

/** Every entry in reading (document) order, children after their parent. */
export function flattenToc(items: readonly TocItem[]): TocItem[] {
  const out: TocItem[] = [];
  const walk = (list: readonly TocItem[]) => {
    for (const item of list) {
      out.push(item);
      walk(item.children);
    }
  };
  walk(items);
  return out;
}

/**
 * The entry the reader is "in": the last entry (in document order) whose
 * chapter is at or before the current one. Null before the first entry.
 */
export function currentTocItem(items: readonly TocItem[], currentChapterIndex: number): TocItem | null {
  let current: TocItem | null = null;
  for (const item of flattenToc(items)) {
    if (item.chapterIndex <= currentChapterIndex) current = item;
  }
  return current;
}

/** The chain of entries from the top level down to `target` (inclusive), or [] if it is not in the tree. */
export function pathTo(items: readonly TocItem[], target: TocItem): TocItem[] {
  for (const item of items) {
    if (item === target) return [item];
    const below = pathTo(item.children, target);
    if (below.length > 0) return [item, ...below];
  }
  return [];
}

export function maxTocDepth(items: readonly TocItem[]): number {
  let max = -1;
  for (const item of flattenToc(items)) max = Math.max(max, item.depth);
  return max;
}

/**
 * Three levels or more (a part > a chapter > a section). Only then does the
 * drawer offer collapsing; one or two levels read fine as a plain indented list.
 */
export function hasDeepNesting(items: readonly TocItem[]): boolean {
  return maxTocDepth(items) >= 2;
}

/** One entry per chapter, "Section N" - for a book with no usable table of contents. */
export function fallbackToc(chapterCount: number): TocItem[] {
  return Array.from({ length: chapterCount }, (_, index) => ({
    id: `t${index}`,
    title: `Section ${index + 1}`,
    chapterIndex: index,
    depth: 0,
    children: [],
  }));
}

/** Collapses whitespace; an empty result becomes "Section N" for the chapter it opens. */
export function cleanTocTitle(raw: string | null | undefined, chapterIndex: number): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  return text || `Section ${chapterIndex + 1}`;
}

/**
 * How far through the book the reader is, 0..1, weighted by each chapter's
 * size (its uncompressed size in the ZIP's central directory - no parsing), so
 * a 200-word interlude does not count as much as a 20,000-word chapter. Falls
 * back to counting chapters equally when the sizes are missing or all zero.
 *
 * `fractionInChapter` is how far through the current chapter (0..1).
 */
export function weightedProgress(weights: readonly number[] | null | undefined, chapterIndex: number, fractionInChapter: number, chapterCount: number): number {
  const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
  const fraction = clamp01(fractionInChapter);
  const usable = weights && weights.length > 0 && weights.every((w) => Number.isFinite(w) && w >= 0) && weights.reduce((a, b) => a + b, 0) > 0;
  if (!usable) {
    const count = chapterCount > 0 ? chapterCount : 1;
    return clamp01((Math.min(Math.max(0, chapterIndex), count - 1) + fraction) / count);
  }
  const index = Math.min(Math.max(0, chapterIndex), weights.length - 1);
  let before = 0;
  for (let i = 0; i < index; i++) before += weights[i];
  const total = weights.reduce((a, b) => a + b, 0);
  return clamp01((before + weights[index] * fraction) / total);
}
