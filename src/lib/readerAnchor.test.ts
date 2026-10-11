import { describe, expect, it } from 'vitest';
import {
  computeAnchor,
  computeProgressFraction,
  findBlockAtY,
  flattenToLeafBlocks,
  resolveAnchorToDocumentY,
  type Rect,
} from './readerAnchor';

function el(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.firstElementChild as HTMLElement;
}

describe('flattenToLeafBlocks', () => {
  it('returns direct leaf children unchanged for flat chapter markup', () => {
    const chapter = el('<section><h2>Title</h2><p>one</p><p>two</p></section>');
    const blocks = flattenToLeafBlocks(chapter);
    expect(blocks.map((b) => b.tagName.toLowerCase())).toEqual(['h2', 'p', 'p']);
    expect(blocks.map((b) => b.textContent)).toEqual(['Title', 'one', 'two']);
  });

  it('flattens through a whole chapter wrapped in one generic <div>, finding the real paragraphs inside', () => {
    const chapter = el('<section><div><p>alpha</p><p>beta</p><p>gamma</p></div></section>');
    const blocks = flattenToLeafBlocks(chapter);
    expect(blocks.map((b) => b.tagName.toLowerCase())).toEqual(['p', 'p', 'p']);
    expect(blocks.map((b) => b.textContent)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('flattens through nested generic wrappers (div inside span inside section)', () => {
    const chapter = el('<section><span><div><p>deep</p></div></span></section>');
    const blocks = flattenToLeafBlocks(chapter);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toBe('deep');
  });

  it('recurses into ul/ol to find individual <li> as separate blocks, not the list as one block', () => {
    const chapter = el('<section><ul><li>first</li><li>second</li></ul></section>');
    const blocks = flattenToLeafBlocks(chapter);
    expect(blocks.map((b) => b.tagName.toLowerCase())).toEqual(['li', 'li']);
  });

  it('treats the .scroll-x wrapper as one atomic leaf, not recursing into the table/pre inside it', () => {
    const chapter = el('<section><div class="scroll-x"><table><tr><td>a</td></tr></table></div></section>');
    const blocks = flattenToLeafBlocks(chapter);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].className).toBe('scroll-x');
  });

  it('falls back to treating a generic container as a leaf when it has no leaf descendants (bare inline content)', () => {
    const chapter = el('<section><span>just text, no block children</span></section>');
    const blocks = flattenToLeafBlocks(chapter);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tagName.toLowerCase()).toBe('span');
  });

  it('returns an empty array for a chapter with no element children', () => {
    const chapter = el('<section></section>');
    expect(flattenToLeafBlocks(chapter)).toEqual([]);
  });
});

// Fake rects keyed by element identity - lets the binary search / anchor
// pipeline be tested without a real layout engine (jsdom doesn't compute
// real geometry).
function rectMap(entries: [Element, Rect][]): (el: Element) => Rect {
  const map = new Map(entries);
  return (e: Element) => {
    const r = map.get(e);
    if (!r) throw new Error('no fake rect registered for element');
    return r;
  };
}

describe('findBlockAtY', () => {
  it('finds the block whose range contains referenceY', () => {
    const a = el('<p>a</p>');
    const b = el('<p>b</p>');
    const c = el('<p>c</p>');
    const rectOf = rectMap([
      [a, { top: 0, bottom: 10 }],
      [b, { top: 10, bottom: 30 }],
      [c, { top: 30, bottom: 50 }],
    ]);
    expect(findBlockAtY([a, b, c], 5, rectOf).index).toBe(0);
    expect(findBlockAtY([a, b, c], 15, rectOf).index).toBe(1);
    expect(findBlockAtY([a, b, c], 45, rectOf).index).toBe(2);
  });

  it('computes the correct fraction within the found block', () => {
    const a = el('<p>a</p>');
    const rectOf = rectMap([[a, { top: 100, bottom: 200 }]]);
    expect(findBlockAtY([a], 125, rectOf).fraction).toBeCloseTo(0.25);
    expect(findBlockAtY([a], 100, rectOf).fraction).toBeCloseTo(0);
    expect(findBlockAtY([a], 200, rectOf).fraction).toBeCloseTo(1);
  });

  it('clamps to the first block when referenceY is above everything', () => {
    const a = el('<p>a</p>');
    const b = el('<p>b</p>');
    const rectOf = rectMap([
      [a, { top: 100, bottom: 150 }],
      [b, { top: 150, bottom: 200 }],
    ]);
    const result = findBlockAtY([a, b], -500, rectOf);
    expect(result.index).toBe(0);
    expect(result.fraction).toBe(0);
  });

  it('clamps to the last block when referenceY is past everything', () => {
    const a = el('<p>a</p>');
    const b = el('<p>b</p>');
    const rectOf = rectMap([
      [a, { top: 0, bottom: 50 }],
      [b, { top: 50, bottom: 100 }],
    ]);
    const result = findBlockAtY([a, b], 9999, rectOf);
    expect(result.index).toBe(1);
    expect(result.fraction).toBe(1);
  });

  it('works correctly over a large (thousands-long) monotonic sequence - binary search correctness, not just small cases', () => {
    const blocks = Array.from({ length: 5000 }, () => el('<p>x</p>'));
    const rectOf = rectMap(blocks.map((b, i) => [b, { top: i * 20, bottom: i * 20 + 20 }] as [Element, Rect]));
    const result = findBlockAtY(blocks, 3000 * 20 + 5, rectOf);
    expect(result.index).toBe(3000);
  });
});

describe('computeAnchor + resolveAnchorToDocumentY (round trip)', () => {
  function buildChapters(): { chapters: HTMLElement[]; rectOf: (el: Element) => Rect } {
    const c0 = el('<section><p>c0-p0</p><p>c0-p1</p></section>');
    const c1 = el('<section><div><p>c1-p0</p><p>c1-p1</p><p>c1-p2</p></div></section>');
    const c2 = el('<section><p>c2-p0</p></section>');
    const chapters = [c0, c1, c2];

    // Lay chapters out back to back, each block 20px tall, chapters
    // separated by a 10px gap - a plausible, if arbitrary, document layout.
    const entries: [Element, Rect][] = [];
    let y = 0;
    for (const chapter of chapters) {
      const blocks = flattenToLeafBlocks(chapter);
      const chapterTop = y;
      for (const block of blocks) {
        entries.push([block, { top: y, bottom: y + 20 }]);
        y += 20;
      }
      entries.push([chapter, { top: chapterTop, bottom: y }]);
      y += 10;
    }
    return { chapters, rectOf: rectMap(entries) };
  }

  it('computes an anchor matching the block actually at referenceY, and resolving it returns to the same block', () => {
    const { chapters, rectOf } = buildChapters();
    // c1's second block (c1-p1) sits at y=40..60 relative to its own chapter
    // start; with c0 occupying 0..40 and a 10px gap, c1 starts at 50, so its
    // blocks are at 50..70 (p0) and 70..90 (p1).
    const anchor = computeAnchor(chapters, 75, rectOf);
    expect(anchor).not.toBeNull();
    expect(anchor!.chapterIndex).toBe(1);
    expect(anchor!.blockIndex).toBe(1);
    expect(chapters[anchor!.chapterIndex].textContent).toContain('c1-p1');

    const resolvedY = resolveAnchorToDocumentY(chapters, anchor!, 0, rectOf);
    // Resolving should land back within the same block's [top,bottom) range.
    const blockRect = rectOf(flattenToLeafBlocks(chapters[1])[1]);
    expect(resolvedY).toBeGreaterThanOrEqual(blockRect.top);
    expect(resolvedY).toBeLessThanOrEqual(blockRect.bottom);
  });

  it('round-trips through a chapter wrapped in a generic div (paragraph-accurate, not chapter-level only)', () => {
    const { chapters, rectOf } = buildChapters();
    const anchor = computeAnchor(chapters, 75, rectOf);
    expect(anchor!.chapterIndex).toBe(1); // the div-wrapped chapter
    // Confirm it picked a specific paragraph inside the div, not just "chapter 1, block 0"
    const blocks = flattenToLeafBlocks(chapters[1]);
    expect(blocks[anchor!.blockIndex].textContent).toBe('c1-p1');
  });

  it('clamps an out-of-range chapterIndex to the last real chapter', () => {
    const { chapters, rectOf } = buildChapters();
    const anchor = { chapterIndex: 999, blockIndex: 0, blockFraction: 0 };
    const resolvedY = resolveAnchorToDocumentY(chapters, anchor, 0, rectOf);
    expect(resolvedY).not.toBeNull();
    const lastChapterBlocks = flattenToLeafBlocks(chapters[chapters.length - 1]);
    const firstBlockRect = rectOf(lastChapterBlocks[0]);
    expect(resolvedY).toBe(firstBlockRect.top);
  });

  it('clamps an out-of-range blockIndex to the last real block in that chapter', () => {
    const { chapters, rectOf } = buildChapters();
    const anchor = { chapterIndex: 1, blockIndex: 999, blockFraction: 0.5 };
    const resolvedY = resolveAnchorToDocumentY(chapters, anchor, 0, rectOf);
    const blocks = flattenToLeafBlocks(chapters[1]);
    const lastBlockRect = rectOf(blocks[blocks.length - 1]);
    expect(resolvedY).toBe(lastBlockRect.top + 0.5 * (lastBlockRect.bottom - lastBlockRect.top));
  });

  it('returns null for computeAnchor/resolveAnchorToDocumentY when there are no chapters at all', () => {
    expect(computeAnchor([], 0)).toBeNull();
    expect(resolveAnchorToDocumentY([], { chapterIndex: 0, blockIndex: 0, blockFraction: 0 }, 0)).toBeNull();
  });
});

describe('computeProgressFraction', () => {
  it('is 0 at the very first block of the first chapter', () => {
    const anchor = { chapterIndex: 0, blockIndex: 0, blockFraction: 0 };
    expect(computeProgressFraction(anchor, 10, 20)).toBeCloseTo(0);
  });

  it('increases smoothly within a single chapter via block position, not just at chapter boundaries', () => {
    const early = computeProgressFraction({ chapterIndex: 0, blockIndex: 1, blockFraction: 0 }, 10, 20);
    const late = computeProgressFraction({ chapterIndex: 0, blockIndex: 8, blockFraction: 0 }, 10, 20);
    expect(late).toBeGreaterThan(early);
    expect(late).toBeLessThan(1 / 20); // still within chapter 0's 1/20 share of the book
  });

  it('is approximately 0.5 at the midpoint chapter, start of chapter', () => {
    const anchor = { chapterIndex: 10, blockIndex: 0, blockFraction: 0 };
    expect(computeProgressFraction(anchor, 5, 20)).toBeCloseTo(0.5, 1);
  });

  it('is clamped to 1 even if chapterIndex is somehow at/past the last chapter', () => {
    const anchor = { chapterIndex: 19, blockIndex: 0, blockFraction: 1 };
    expect(computeProgressFraction(anchor, 1, 20)).toBeLessThanOrEqual(1);
    expect(computeProgressFraction({ chapterIndex: 25, blockIndex: 0, blockFraction: 0 }, 5, 20)).toBe(1);
  });

  it('is 0 when totalChapters is 0 (book not yet known)', () => {
    expect(computeProgressFraction({ chapterIndex: 0, blockIndex: 0, blockFraction: 0 }, 5, 0)).toBe(0);
  });

  it('falls back to chapter-only granularity when blockCountInChapter is 0', () => {
    const anchor = { chapterIndex: 4, blockIndex: 0, blockFraction: 0.9 }; // blockFraction irrelevant with 0 blocks
    expect(computeProgressFraction(anchor, 0, 10)).toBeCloseTo(0.4);
  });
});
