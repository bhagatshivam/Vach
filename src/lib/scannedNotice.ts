import type { PageKind } from './pdf';

// A scanned (all-image) book is detected from a rolling window of the last
// WINDOW_SIZE pages that actually have content - a 'blank' page (genuinely
// empty, see pdf.ts) is excluded from the window either way by pushKind
// below, so it can't dilute the ratio in either direction. Once that many
// pages have streamed in, THRESHOLD of them being raster (image/vector-art)
// rather than real text is treated as "this is very likely a scanned or
// photographed book, not a normally-illustrated novel". 15 pages and 80%
// (rather than a smaller window or a bare majority) specifically so a novel
// with a handful of upfront color plates - illustrations, a map, author
// photos - doesn't trip this just because its first few pages happen to be
// images; see pushKind's fixture-driving test for the specific "6 image
// pages then normal text" case this is meant to not fire on.
export const SCANNED_NOTICE_WINDOW_SIZE = 15;
export const SCANNED_NOTICE_THRESHOLD = 0.8;

/**
 * Pushes one page's classification into a rolling window, dropping the
 * oldest entry once it's past SCANNED_NOTICE_WINDOW_SIZE, and returning the
 * (possibly unchanged) array - never mutates its input, so callers that
 * keep this in a ref can just reassign `ref.current = pushKind(...)`.
 */
export function pushKind(window: readonly PageKind[], kind: PageKind): PageKind[] {
  if (kind === 'blank') return window as PageKind[];
  const next = [...window, kind];
  return next.length > SCANNED_NOTICE_WINDOW_SIZE ? next.slice(next.length - SCANNED_NOTICE_WINDOW_SIZE) : next;
}

/** True once the window is full and at least THRESHOLD of it is raster. */
export function shouldShowScannedNotice(window: readonly PageKind[]): boolean {
  if (window.length < SCANNED_NOTICE_WINDOW_SIZE) return false;
  const rasterCount = window.filter((k) => k === 'raster').length;
  return rasterCount / SCANNED_NOTICE_WINDOW_SIZE >= SCANNED_NOTICE_THRESHOLD;
}
