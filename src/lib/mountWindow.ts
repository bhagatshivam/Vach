// Which chapters of a long book are mounted in the page, and when to change that. Pure: it is given where each mounted
// chapter measures on screen right now and answers what to load and what to unmount.
//
// WHY THE PAGE MUST STAY SHORT. Chromium stops painting past about 2^23 px (8.4 million CSS px) of scroll offset: the
// DOM and the geometry still say the text is there, but the screen is blank. If every chapter after the reader stays
// mounted, a long book is one very tall page and a hard fling down it ends in that blank. So only a window of chapters
// around the reader is mounted, both ahead of them and behind them, and the page is exactly as tall as that window. There
// are NO placeholder spacers standing in for the chapters that are not mounted: a spacer is height, and height is the
// problem. The reader scrolls through the window; the window follows the reader.
//
// The window is measured in what is on screen, not in chapters: a chapter can be a few hundred pixels or hundreds of
// thousands. Chapters are loaded while less than LOAD_MARGIN_VIEWPORTS of mounted text remains beyond the screen
// (ahead or behind), and unmounted only while more than KEEP_MARGIN_VIEWPORTS would still remain beyond the screen
// without them. The gap between the two numbers is the hysteresis that keeps a chapter from being loaded and dropped on
// alternate frames when the reader hovers at a boundary. MAX_MOUNTED_PX is a hard ceiling behind both.

/** Load another chapter while there are fewer than this many viewport heights of mounted content beyond the screen. */
export const LOAD_MARGIN_VIEWPORTS = 5;

/** Unmount a chapter only if at least this many viewport heights of mounted content would remain beyond the screen without it. */
export const KEEP_MARGIN_VIEWPORTS = 12;

/**
 * The most page height the window may hold, in CSS px. Well under MAX_DIRECT_JUMP_OFFSET_PX (2,000,000, chapterWindow.ts)
 * so that anything in the window can be scrolled to directly, and far under the 2^23 where painting stops. Only
 * chapters that are not on screen are unmounted to honour it: one chapter that is taller than this on its own is
 * mounted whole.
 */
export const MAX_MOUNTED_PX = 1_500_000;

/** Where a mounted chapter is, relative to the top of the viewport (what getBoundingClientRect reports). */
export interface ChapterBox {
  top: number;
  bottom: number;
}

export interface WindowInput {
  /** Book index of the first mounted chapter. */
  firstIndex: number;
  /** Measured boxes of the mounted chapters, in order. */
  boxes: readonly ChapterBox[];
  chapterCount: number;
  viewportHeight: number;
  /** A chapter (by book index) that must stay mounted, and so everything between it and the end it would be dropped from. */
  isPinned?: (chapterIndex: number) => boolean;
}

export interface WindowPlan {
  /** Chapters to unmount from the start of the window. */
  dropHead: number;
  /** Chapters to unmount from the end of the window. */
  dropTail: number;
  /** Mount the chapter before the window (book index firstIndex - 1). */
  loadPrevious: boolean;
  /** Mount the chapter after the window. */
  loadNext: boolean;
  /**
   * Position (in `boxes`) of the chapter at the top of the screen: the one whose place on screen has to be kept when
   * chapters above it are unmounted. Never dropped.
   */
  anchor: number;
}

/** The first mounted chapter that reaches into the viewport (or the nearest one, if the viewport is past them all). */
export function anchorPosition(boxes: readonly ChapterBox[]): number {
  for (let i = 0; i < boxes.length; i++) if (boxes[i].bottom > 0) return i;
  return Math.max(0, boxes.length - 1);
}

export function planWindow(input: WindowInput): WindowPlan {
  const { firstIndex, boxes, chapterCount, viewportHeight } = input;
  const none: WindowPlan = { dropHead: 0, dropTail: 0, loadPrevious: false, loadNext: false, anchor: 0 };
  const n = boxes.length;
  if (n === 0 || viewportHeight <= 0) return none;
  const pinned = input.isPinned ?? (() => false);
  const load = LOAD_MARGIN_VIEWPORTS * viewportHeight;
  const keep = KEEP_MARGIN_VIEWPORTS * viewportHeight;

  const anchor = anchorPosition(boxes);
  // The last chapter that reaches into the viewport: everything from the anchor to here is on screen and stays.
  let lastVisible = anchor;
  while (lastVisible + 1 < n && boxes[lastVisible + 1].top < viewportHeight) lastVisible++;

  // Behind the reader: drop from the start while the chapters that remain still leave a full margin above the screen.
  let dropHead = 0;
  for (let count = 1; count <= anchor; count++) {
    if (pinned(firstIndex + count - 1)) break;
    if (-boxes[count].top >= keep) dropHead = count;
    else break;
  }
  // Ahead of the reader: the same from the end.
  let dropTail = 0;
  for (let last = n - 2; last >= lastVisible; last--) {
    if (pinned(firstIndex + last + 1)) break;
    if (boxes[last].bottom - viewportHeight >= keep) dropTail = n - 1 - last;
    else break;
  }

  // The hard ceiling: if what is left is still taller than MAX_MOUNTED_PX, shed the chapter farthest from the screen,
  // whichever end it is at, until it fits or only chapters on screen (or pinned ones) are left.
  const heightWithout = (head: number, tail: number) => boxes[n - 1 - tail].bottom - boxes[head].top;
  while (heightWithout(dropHead, dropTail) > MAX_MOUNTED_PX) {
    const head = dropHead;
    const tail = n - 1 - dropTail;
    const canHead = head < anchor && !pinned(firstIndex + head);
    const canTail = tail > lastVisible && !pinned(firstIndex + tail);
    if (!canHead && !canTail) break;
    const headDistance = canHead ? -boxes[head].bottom : -Infinity;
    const tailDistance = canTail ? boxes[tail].top - viewportHeight : -Infinity;
    if (headDistance >= tailDistance) dropHead++;
    else dropTail++;
  }

  const above = -boxes[dropHead].top;
  const below = boxes[n - 1 - dropTail].bottom - viewportHeight;
  const room = MAX_MOUNTED_PX - heightWithout(dropHead, dropTail);
  // At the ceiling a side is only extended when the reader is about to run out on it: a chapter is better late than
  // the window growing without end.
  const wants = (margin: number) => margin < load && (room > 0 || margin < viewportHeight);

  return {
    dropHead,
    dropTail,
    loadPrevious: dropHead === 0 && firstIndex > 0 && wants(above),
    loadNext: dropTail === 0 && firstIndex + n < chapterCount && wants(below),
    anchor,
  };
}
