import { describe, expect, it } from 'vitest';
import { KEEP_MARGIN_VIEWPORTS, LOAD_MARGIN_VIEWPORTS, MAX_MOUNTED_PX, anchorPosition, planWindow, type ChapterBox } from './mountWindow';
import { MAX_DIRECT_JUMP_OFFSET_PX } from './chapterWindow';

const VH = 800;

/** Where each chapter of a book of these heights is, given the window [first, last] is mounted and the viewport top is at book offset `y`. */
function boxesFor(heights: readonly number[], first: number, last: number, y: number): ChapterBox[] {
  const prefix = [0];
  for (const h of heights) prefix.push(prefix[prefix.length - 1] + h);
  const boxes: ChapterBox[] = [];
  for (let i = first; i <= last; i++) boxes.push({ top: prefix[i] - y, bottom: prefix[i + 1] - y });
  return boxes;
}

/** Applies the plan over and over, as the reader does after every commit, until it asks for nothing more. */
function settle(heights: readonly number[], start: [number, number], y: number, isPinned?: (i: number) => boolean) {
  let [first, last] = start;
  const steps: string[] = [];
  for (let guard = 0; guard < 500; guard++) {
    const plan = planWindow({ firstIndex: first, boxes: boxesFor(heights, first, last, y), chapterCount: heights.length, viewportHeight: VH, isPinned });
    if (plan.dropHead > 0 || plan.dropTail > 0) {
      first += plan.dropHead;
      last -= plan.dropTail;
      steps.push(`drop ${plan.dropHead}/${plan.dropTail}`);
      continue;
    }
    if (!plan.loadPrevious && !plan.loadNext) return { first, last, steps };
    if (plan.loadPrevious) first--;
    if (plan.loadNext) last++;
    steps.push(`load ${plan.loadPrevious ? 'prev ' : ''}${plan.loadNext ? 'next' : ''}`.trim());
  }
  throw new Error(`the window never settled: ${steps.slice(-8).join(', ')}`);
}

const uniform = (count: number, height: number) => Array.from({ length: count }, () => height);
const total = (heights: readonly number[], first: number, last: number) => heights.slice(first, last + 1).reduce((a, b) => a + b, 0);

describe('anchorPosition', () => {
  it('is the first chapter that reaches into the viewport', () => {
    expect(anchorPosition([{ top: -500, bottom: -100 }, { top: -100, bottom: 300 }, { top: 300, bottom: 900 }])).toBe(1);
  });
  it('is the first chapter when the viewport is above all of them, and the last when it is below all of them', () => {
    expect(anchorPosition([{ top: 40, bottom: 400 }, { top: 400, bottom: 900 }])).toBe(0);
    expect(anchorPosition([{ top: -900, bottom: -400 }, { top: -400, bottom: -10 }])).toBe(1);
  });
});

describe('planWindow - what to load', () => {
  it('loads the next chapter while fewer than the load margin of screens remain below, and not when more do', () => {
    const heights = uniform(40, 6000);
    // Window 3..5, reader at the very top of chapter 3: 2 chapters (12,000px) below the screen = 15 screens: plenty.
    expect(planWindow({ firstIndex: 3, boxes: boxesFor(heights, 3, 5, 3 * 6000), chapterCount: 40, viewportHeight: VH }).loadNext).toBe(false);
    // Reader 1,000px from the end of chapter 5: only 200px below the screen.
    const near = planWindow({ firstIndex: 3, boxes: boxesFor(heights, 3, 5, 6 * 6000 - 1800), chapterCount: 40, viewportHeight: VH });
    expect(near.loadNext).toBe(true);
    expect(near.loadPrevious).toBe(false);
  });

  it(`loads the previous chapter once fewer than ${LOAD_MARGIN_VIEWPORTS} screens remain above`, () => {
    const heights = uniform(40, 6000);
    const justUnder = LOAD_MARGIN_VIEWPORTS * VH - 100;
    expect(planWindow({ firstIndex: 3, boxes: boxesFor(heights, 3, 5, 3 * 6000 + justUnder), chapterCount: 40, viewportHeight: VH }).loadPrevious).toBe(true);
    expect(planWindow({ firstIndex: 3, boxes: boxesFor(heights, 3, 5, 3 * 6000 + LOAD_MARGIN_VIEWPORTS * VH + 100), chapterCount: 40, viewportHeight: VH }).loadPrevious).toBe(false);
  });

  it('never loads before chapter 0 or after the last chapter', () => {
    const heights = uniform(3, 500);
    const plan = planWindow({ firstIndex: 0, boxes: boxesFor(heights, 0, 2, 100), chapterCount: 3, viewportHeight: VH });
    expect(plan.loadPrevious).toBe(false);
    expect(plan.loadNext).toBe(false);
  });

  it('a book of short chapters is filled in chapter after chapter, without another scroll event', () => {
    const heights = uniform(400, 300); // 120,000px of short chapters
    const { first, last } = settle(heights, [100, 100], 100 * 300 + 50);
    // The window now reaches the load margin on both sides of the screen.
    expect(first).toBeLessThan(100);
    expect(last).toBeGreaterThan(100);
    expect(100 * 300 + 50 - first * 300).toBeGreaterThanOrEqual(LOAD_MARGIN_VIEWPORTS * VH);
    expect((last + 1) * 300 - (100 * 300 + 50 + VH)).toBeGreaterThanOrEqual(LOAD_MARGIN_VIEWPORTS * VH);
  });
});

describe('planWindow - what to unmount', () => {
  it('unmounts chapters behind the reader only while the full keep margin would remain above the screen', () => {
    const heights = uniform(60, 1000);
    // Window 0..30, reader in chapter 20: chapters 0..9 end more than 12 screens (9,600px) above the screen's top.
    const plan = planWindow({ firstIndex: 0, boxes: boxesFor(heights, 0, 30, 20 * 1000 + 500), chapterCount: 60, viewportHeight: VH });
    // Dropping `count` chapters leaves (20,500 - 1000*count) above; that must stay >= 12 * 800 = 9,600.
    expect(plan.dropHead).toBe(10);
    expect(20_500 - 1000 * plan.dropHead).toBeGreaterThanOrEqual(KEEP_MARGIN_VIEWPORTS * VH);
    expect(20_500 - 1000 * (plan.dropHead + 1)).toBeLessThan(KEEP_MARGIN_VIEWPORTS * VH);
    expect(plan.anchor).toBe(20);
  });

  it('unmounts chapters ahead of the reader the same way', () => {
    const heights = uniform(60, 1000);
    const plan = planWindow({ firstIndex: 10, boxes: boxesFor(heights, 10, 50, 20 * 1000 + 500), chapterCount: 60, viewportHeight: VH });
    expect(plan.dropTail).toBeGreaterThan(0);
    // The chapters kept still leave the full margin below the screen.
    const lastKept = 50 - plan.dropTail;
    expect((lastKept + 1) * 1000 - (20_500 + VH)).toBeGreaterThanOrEqual(KEEP_MARGIN_VIEWPORTS * VH);
    expect(lastKept).toBeGreaterThanOrEqual(21);
  });

  it('chooses by measured height, not by count: short chapters mean many mounted, tall ones few', () => {
    const shortBook = settle(uniform(500, 200), [200, 200], 200 * 200 + 40);
    const tallBook = settle(uniform(500, 60_000), [200, 200], 200 * 60_000 + 40);
    expect(shortBook.last - shortBook.first + 1).toBeGreaterThan(30);
    expect(tallBook.last - tallBook.first + 1).toBeLessThanOrEqual(3);
    // Either way the same amount of page is mounted, give or take a chapter.
    expect(total(uniform(500, 200), shortBook.first, shortBook.last)).toBeLessThan(40 * VH);
  });

  it('never unmounts a chapter that is on screen, even when it alone is taller than the whole window allowance', () => {
    const heights = [800_000, 800_000, 800_000, 800_000];
    const { first, last } = settle(heights, [0, 3], 1_600_000 + 400_000);
    expect(first).toBeLessThanOrEqual(2);
    expect(last).toBeGreaterThanOrEqual(2);
  });

  it(`holds the page at ${MAX_MOUNTED_PX.toLocaleString('en-US')}px or less by shedding the chapters farthest from the screen`, () => {
    const heights = uniform(30, 400_000);
    const { first, last } = settle(heights, [0, 29], 15 * 400_000 + 100);
    expect(total(heights, first, last)).toBeLessThanOrEqual(MAX_MOUNTED_PX);
    expect(first).toBeLessThanOrEqual(15);
    expect(last).toBeGreaterThanOrEqual(15);
  });

  it('leaves what is pinned (a chapter an overlay is showing) mounted, and everything between it and the reader', () => {
    const heights = uniform(60, 1000);
    const free = settle(heights, [0, 30], 20_500);
    expect(free.first).toBeGreaterThan(0);
    const pinned = settle(heights, [0, 30], 20_500, (i) => i === 2);
    expect(pinned.first).toBeLessThanOrEqual(2);
  });
});

describe('the window follows the reader through a whole book', () => {
  it('keeps the page under the cap and the screen covered all the way through a 10M px book, loading and dropping each chapter at most once per pass', () => {
    // 150 chapters of 70,000px = 10.5M px: the book from the Chromium check that stops painting past 2^23.
    const heights = uniform(150, 70_000);
    const bookHeight = total(heights, 0, 149);
    let range: [number, number] = [0, 0];
    let tallest = 0;
    const loadedAt: number[] = [];
    for (let y = 0; y + VH <= bookHeight; y += 700) {
      const next = settle(heights, range, y);
      if (next.last > range[1]) loadedAt.push(next.last);
      range = [next.first, next.last];
      tallest = Math.max(tallest, total(heights, range[0], range[1]));
      // The screen is covered: the chapters under [y, y+VH] are all mounted.
      const topChapter = Math.floor(y / 70_000);
      const bottomChapter = Math.floor((y + VH - 1) / 70_000);
      expect(range[0]).toBeLessThanOrEqual(topChapter);
      expect(range[1]).toBeGreaterThanOrEqual(bottomChapter);
      // ...and there is more below, until the book ends.
      if (bottomChapter < 149) expect(range[1]).toBeGreaterThanOrEqual(bottomChapter);
    }
    expect(tallest).toBeLessThanOrEqual(MAX_MOUNTED_PX);
    expect(tallest).toBeLessThan(MAX_DIRECT_JUMP_OFFSET_PX);
    // Each chapter was brought in once on the way down, none repeatedly.
    expect(new Set(loadedAt).size).toBe(loadedAt.length);
  });

  it('does not thrash: scrolling back and forth over a chapter boundary never loads and drops on alternate steps', () => {
    const heights = uniform(100, 5_000);
    let range = settle(heights, [40, 41], 41 * 5_000 - 300);
    // One pass over both positions brings in whatever the second one needs; after that nothing should change.
    range = settle(heights, [range.first, range.last], 41 * 5_000 - 300 + 900);
    range = settle(heights, [range.first, range.last], 41 * 5_000 - 300);
    const events: string[] = [];
    for (let i = 0; i < 40; i++) {
      const y = 41 * 5_000 - 300 + (i % 2 === 0 ? 0 : 900);
      const next = settle(heights, [range.first, range.last], y);
      if (next.first !== range.first || next.last !== range.last) events.push(`${next.first}-${next.last}`);
      range = next;
    }
    expect(events).toEqual([]);
  });

  it('settles from any position in any book of mixed chapter sizes, with the screen covered', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let book = 0; book < 25; book++) {
      const heights = Array.from({ length: 60 + Math.floor(random() * 200) }, () => Math.round(150 + random() ** 3 * 150_000));
      const bookHeight = total(heights, 0, heights.length - 1);
      for (let probe = 0; probe < 12; probe++) {
        const y = Math.floor(random() * Math.max(1, bookHeight - VH));
        const chapterAt = heights.findIndex((_, i) => total(heights, 0, i) > y);
        const { first, last } = settle(heights, [chapterAt, chapterAt], y);
        expect(first).toBeLessThanOrEqual(chapterAt);
        expect(total(heights, 0, last)).toBeGreaterThanOrEqual(Math.min(bookHeight, y + VH));
      }
    }
  });
});
