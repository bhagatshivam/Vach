// Pure helpers for reading from a *window* of chapters rather than from
// chapter 0. A saved reading position (readerAnchor.ts) is chapter-relative:
// { chapterIndex, blockIndex, blockFraction }, where blockIndex counts leaf
// blocks inside that one chapter, never across the book - so it stays valid
// no matter which chapters happen to be mounted. Only chapterIndex needs
// translating between "index in the book" and "index among the chapters in
// the DOM", which is what these do.

import type { Anchor } from './readerAnchor';

/** Chapters mounted before the saved one when restoring, so there is content above to scroll into. */
export const RESTORE_CONTEXT_CHAPTERS = 1;

/**
 * Earlier chapters are loaded once the reader is within this many viewport
 * heights of the top of what is mounted, so they are already there when it
 * gets to them rather than appearing under the finger.
 */
export const PREPEND_TRIGGER_VIEWPORTS = 2;

/**
 * The first chapter to mount when opening at a saved position: the saved
 * chapter minus RESTORE_CONTEXT_CHAPTERS, clamped into the book. A stale
 * saved index past the end clamps to the last chapter (the anchor itself is
 * clamped the same way when it is resolved).
 */
export function restoreWindowStart(savedChapterIndex: number, chapterCount: number): number {
  if (chapterCount <= 0) return 0;
  const clamped = Math.min(Math.max(savedChapterIndex, 0), chapterCount - 1);
  return Math.max(0, clamped - RESTORE_CONTEXT_CHAPTERS);
}

/** Book-relative anchor -> anchor over the mounted chapters (index into the DOM list), clamped to what is mounted. */
export function toDomAnchor(anchor: Anchor, firstChapterIndex: number, mountedCount: number): Anchor {
  const last = Math.max(0, mountedCount - 1);
  const chapterIndex = Math.min(Math.max(anchor.chapterIndex - firstChapterIndex, 0), last);
  return { ...anchor, chapterIndex };
}

/** Anchor measured over the mounted chapters -> book-relative anchor, the form that is saved. */
export function toAbsoluteAnchor(domAnchor: Anchor, firstChapterIndex: number): Anchor {
  return { ...domAnchor, chapterIndex: domAnchor.chapterIndex + firstChapterIndex };
}

/** Whether the chapter before the first mounted one should be loaded now. */
export function shouldLoadPrevious(scrollY: number, viewportHeight: number, firstChapterIndex: number): boolean {
  return firstChapterIndex > 0 && scrollY < PREPEND_TRIGGER_VIEWPORTS * viewportHeight;
}

/**
 * How far to scroll so that an element which was at `topBefore` (viewport-
 * relative) is back at the same place after content was inserted above it.
 * Measuring the element itself, rather than assuming a scrollHeight delta,
 * means it is correct whether or not the browser's own scroll anchoring has
 * already compensated (in which case this is ~0).
 */
export function prependCompensation(topBefore: number, topAfter: number): number {
  return topAfter - topBefore;
}
