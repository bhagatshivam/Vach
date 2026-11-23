// Keeping the reader on the same passage when the layout changes under it.
//
// A saved anchor is structural (chapter, block, fraction), so it survives a
// reflow - but only if something re-scrolls to it afterwards. Nothing used to:
// after a font-size change or a rotation the browser's own scroll anchoring
// was all that held the position, and it gives up whenever em-based margins
// change. The flow now is: capture the anchor BEFORE the change, let the new
// layout settle (fonts loaded, tables re-adapted), then scroll back to it.

import { toDomAnchor } from './chapterWindow';
import { computeAnchor, resolveAnchorToDocumentY, type Anchor, type RectOf } from './readerAnchor';
import type { ReaderSettings } from './readerSettings';

/**
 * Whether going from `previous` to `next` can move text: type size, line
 * height, font family, and theme (themes change which fonts and colors apply
 * and are cheap to include). There is no margin setting yet; when there is,
 * it belongs here.
 */
export function settingsAffectLayout(previous: ReaderSettings, next: ReaderSettings): boolean {
  return (
    previous.fontSize !== next.fontSize ||
    previous.lineHeight !== next.lineHeight ||
    previous.fontFamily !== next.fontFamily ||
    previous.theme !== next.theme
  );
}

/**
 * Where to scroll (document Y) to put `anchor` (book-relative, as saved) back
 * at the top of the viewport, given the chapters now in the DOM and the book
 * index of the first of them. Null if there is nothing mounted to resolve against.
 */
export function anchorScrollTarget(
  chapters: Element[],
  anchor: Anchor,
  firstChapterIndex: number,
  scrollY: number,
  rectOf?: RectOf,
): number | null {
  if (chapters.length === 0) return null;
  return resolveAnchorToDocumentY(chapters, toDomAnchor(anchor, firstChapterIndex, chapters.length), scrollY, rectOf);
}

/** Within a pixel and a half: not worth a scroll (and no scroll event, no saved-position churn). */
export function needsScroll(currentY: number, targetY: number): boolean {
  return Math.abs(targetY - currentY) > 1.5;
}

export interface ScrollPort {
  y(): number;
  scrollTo(y: number): void;
}

const windowScroll: ScrollPort = {
  y: () => window.scrollY,
  scrollTo: (y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' }),
};

/**
 * Runs `work` (DOM writes that may change heights above the reading position,
 * such as a wide table becoming cards) and then scrolls so that the passage
 * that was at the top of the screen still is. The anchor is read before and
 * resolved after, over the same chapters in the DOM, so it needs no book
 * index. Does nothing extra when nothing moved.
 */
export function preserveAnchorDuring(
  getChapters: () => Element[],
  work: () => void,
  scroll: ScrollPort = windowScroll,
  rectOf?: RectOf,
): void {
  const before = computeAnchor(getChapters(), 0, rectOf);
  work();
  if (!before) return;
  const y = resolveAnchorToDocumentY(getChapters(), before, scroll.y(), rectOf);
  if (y !== null && needsScroll(scroll.y(), y)) scroll.scrollTo(y);
}
