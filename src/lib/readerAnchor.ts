// Structural reading-position anchor: which leaf block (not a raw pixel
// offset) the reader is at, plus a fractional offset within it. A pixel
// scrollTop is wrong because text reflows whenever font size, line height,
// or theme changes - chapterIndex/blockIndex/blockFraction describe *what*
// the user is looking at, not *where* on screen it currently happens to
// render, so restoring it after a settings change still lands on the same
// paragraph.

export interface Anchor {
  chapterIndex: number;
  blockIndex: number;
  /** 0 at the block's own top edge, 1 at its bottom edge. */
  blockFraction: number;
}

export interface Rect {
  top: number;
  bottom: number;
}

export type RectOf = (el: Element) => Rect;

// Real leaf content a chapter/page can be made of. <pre> and <table> aren't
// listed separately: both are wrapped in a <div class="scroll-x"> after
// sanitization (see epub.ts), so a bare, unwrapped <pre>/<table> never
// actually appears as a direct leaf in practice - the wrapper is the one
// atomic leaf for either case. <table> stays here anyway as a defensive
// fallback, not a case this is expected to actually hit.
const LEAF_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre', 'blockquote', 'figure', 'img', 'table']);

function isLeafBlock(el: Element): boolean {
  if (el.classList.contains('scroll-x')) return true;
  return LEAF_TAGS.has(el.tagName.toLowerCase());
}

/**
 * Walks a chapter's DOM, flattening through generic wrapper containers
 * (div/span/section/ul/ol - anything not itself a recognized leaf tag or
 * the .scroll-x wrapper) to find the real leaf blocks inside them. A whole
 * chapter wrapped in one outer <div> still yields its individual
 * paragraphs, not one giant block - the wrapper contributes nothing to the
 * block list itself, only its children do.
 *
 * A generic container with no leaf descendants at all (e.g. a bare <span>
 * directly under the chapter, wrapping only inline text) falls back to
 * being treated as a leaf itself - there's nothing finer to point at.
 */
export function flattenToLeafBlocks(root: Element): Element[] {
  const result: Element[] = [];

  function walk(el: Element): void {
    for (const child of Array.from(el.children)) {
      if (isLeafBlock(child)) {
        result.push(child);
        continue;
      }
      const before = result.length;
      walk(child);
      if (result.length === before) {
        result.push(child);
      }
    }
  }

  walk(root);
  return result;
}

/**
 * Binary search over a list of elements assumed to be in monotonically
 * increasing document-order position (true for normal block flow - nothing
 * in this app's CSS uses position/transform in a way that would reorder
 * elements out of their DOM sequence). Finds the first element whose
 * bottom edge is past referenceY, i.e. the element referenceY currently
 * falls inside (or just before, if referenceY is above everything, or the
 * last element, if referenceY is past everything - both cases clamp
 * naturally rather than needing a separate out-of-range branch).
 *
 * rectOf is injected rather than calling getBoundingClientRect() directly
 * so this is unit-testable without a real layout engine (jsdom doesn't
 * compute real geometry) - production code passes a real
 * getBoundingClientRect()-backed accessor, tests pass a fake lookup table.
 */
export function findBlockAtY(blocks: Element[], referenceY: number, rectOf: RectOf): { index: number; fraction: number } {
  if (blocks.length === 0) return { index: 0, fraction: 0 };

  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rectOf(blocks[mid]).bottom <= referenceY) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const rect = rectOf(blocks[lo]);
  const height = rect.bottom - rect.top;
  const fraction = height > 0 ? Math.min(1, Math.max(0, (referenceY - rect.top) / height)) : 0;
  return { index: lo, fraction };
}

/**
 * The library's progress-fraction formula, pulled out as a pure function so
 * it has one definition and one set of tests instead of being inline in
 * ReaderScreen - chapterIndex and within-chapter block position both
 * contribute, so progress reads smoothly within a single long chapter
 * instead of jumping only at chapter boundaries.
 */
export function computeProgressFraction(anchor: Anchor, blockCountInChapter: number, totalChapters: number): number {
  if (totalChapters <= 0) return 0;
  const blockFractionInChapter =
    blockCountInChapter > 0 ? (anchor.blockIndex + anchor.blockFraction) / blockCountInChapter : 0;
  return Math.min(1, Math.max(0, (anchor.chapterIndex + blockFractionInChapter) / totalChapters));
}

function defaultRectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom };
}

/**
 * Computes the current reading anchor from the live DOM: which chapter
 * section and which leaf block within it currently sit at referenceY
 * (viewport-relative - callers pass 0 for "the viewport's top edge", the
 * reference line used throughout this module), plus the fractional offset
 * within that block.
 */
export function computeAnchor(chapters: Element[], referenceY: number, rectOf: RectOf = defaultRectOf): Anchor | null {
  if (chapters.length === 0) return null;

  const { index: chapterIndex } = findBlockAtY(chapters, referenceY, rectOf);
  const blocks = flattenToLeafBlocks(chapters[chapterIndex]);
  if (blocks.length === 0) {
    return { chapterIndex, blockIndex: 0, blockFraction: 0 };
  }

  const { index: blockIndex, fraction: blockFraction } = findBlockAtY(blocks, referenceY, rectOf);
  return { chapterIndex, blockIndex, blockFraction };
}

/**
 * Resolves a saved anchor back to a document-absolute Y to scroll to.
 * Clamps chapterIndex/blockIndex to whatever actually exists (a stale or
 * corrupted anchor pointing past the real chapter/block count lands on the
 * nearest valid spot instead of failing or scrolling to nowhere).
 * currentScrollY converts the viewport-relative rect back to a
 * document-absolute scrollTo() target; it's a parameter (not read via
 * window.scrollY internally) purely for testability.
 */
export function resolveAnchorToDocumentY(
  chapters: Element[],
  anchor: Anchor,
  currentScrollY: number,
  rectOf: RectOf = defaultRectOf,
): number | null {
  if (chapters.length === 0) return null;

  const chapterIndex = Math.min(Math.max(anchor.chapterIndex, 0), chapters.length - 1);
  const chapterEl = chapters[chapterIndex];
  const blocks = flattenToLeafBlocks(chapterEl);
  const target = blocks.length > 0 ? blocks[Math.min(Math.max(anchor.blockIndex, 0), blocks.length - 1)] : chapterEl;

  const rect = rectOf(target);
  const fraction = Math.min(1, Math.max(0, anchor.blockFraction));
  const viewportY = rect.top + fraction * (rect.bottom - rect.top);
  return viewportY + currentScrollY;
}
