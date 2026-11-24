import { describe, expect, it } from 'vitest';
import { cleanTocTitle, currentTocItem, fallbackToc, flattenToc, hasDeepNesting, maxTocDepth, pathTo, weightedProgress, type TocItem } from './toc';

const item = (id: string, chapterIndex: number, depth = 0, children: TocItem[] = []): TocItem => ({ id, title: id, chapterIndex, depth, children });

const nested: TocItem[] = [
  item('part1', 0, 0, [item('ch1', 1, 1, [item('s1', 1, 2), item('s2', 2, 2)]), item('ch2', 3, 1)]),
  item('part2', 5, 0, [item('ch3', 6, 1)]),
];

describe('flattenToc', () => {
  it('lists every entry in document order, parents before their children', () => {
    expect(flattenToc(nested).map((i) => i.id)).toEqual(['part1', 'ch1', 's1', 's2', 'ch2', 'part2', 'ch3']);
    expect(flattenToc([])).toEqual([]);
  });
});

describe('currentTocItem (the last entry whose chapter is <= the current one)', () => {
  it('is null before the first entry, then follows the reader', () => {
    const items = [item('a', 2), item('b', 5), item('c', 9)];
    expect(currentTocItem(items, 0)).toBeNull();
    expect(currentTocItem(items, 2)?.id).toBe('a');
    expect(currentTocItem(items, 4)?.id).toBe('a');
    expect(currentTocItem(items, 5)?.id).toBe('b');
    expect(currentTocItem(items, 100)?.id).toBe('c');
  });

  it('with several entries in one chapter, the last of them; nested entries count in document order', () => {
    expect(currentTocItem(nested, 1)?.id).toBe('s1');
    expect(currentTocItem(nested, 2)?.id).toBe('s2');
    expect(currentTocItem(nested, 4)?.id).toBe('ch2');
    expect(currentTocItem(nested, 6)?.id).toBe('ch3');
  });

  it('is null for an empty TOC', () => {
    expect(currentTocItem([], 3)).toBeNull();
  });
});

describe('pathTo / depth', () => {
  it('gives the chain from the top level down to an entry, or nothing if it is not in the tree', () => {
    const s2 = flattenToc(nested).find((i) => i.id === 's2')!;
    expect(pathTo(nested, s2).map((i) => i.id)).toEqual(['part1', 'ch1', 's2']);
    expect(pathTo(nested, item('stranger', 0))).toEqual([]);
  });

  it('only a book three levels deep counts as deeply nested', () => {
    expect(maxTocDepth(nested)).toBe(2);
    expect(hasDeepNesting(nested)).toBe(true);
    expect(hasDeepNesting([item('a', 0, 0, [item('b', 1, 1)])])).toBe(false);
    expect(hasDeepNesting([item('a', 0)])).toBe(false);
    expect(hasDeepNesting([])).toBe(false);
  });
});

describe('fallbackToc and titles', () => {
  it('one "Section N" entry per chapter', () => {
    const items = fallbackToc(3);
    expect(items.map((i) => [i.title, i.chapterIndex, i.depth])).toEqual([['Section 1', 0, 0], ['Section 2', 1, 0], ['Section 3', 2, 0]]);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    expect(fallbackToc(0)).toEqual([]);
  });

  it('cleanTocTitle collapses whitespace and never returns an empty title', () => {
    expect(cleanTocTitle('  Chapter\n  One  ', 4)).toBe('Chapter One');
    expect(cleanTocTitle('', 4)).toBe('Section 5');
    expect(cleanTocTitle('   \n ', 0)).toBe('Section 1');
    expect(cleanTocTitle(null, 2)).toBe('Section 3');
    expect(cleanTocTitle(undefined, 2)).toBe('Section 3');
  });
});

describe('weightedProgress', () => {
  const weights = [100, 300, 600]; // 1000 bytes: chapter 2 is 60% of the book

  it('weights by chapter size, not chapter count', () => {
    expect(weightedProgress(weights, 0, 0, 3)).toBe(0);
    expect(weightedProgress(weights, 1, 0, 3)).toBeCloseTo(0.1);
    expect(weightedProgress(weights, 2, 0, 3)).toBeCloseTo(0.4);
    expect(weightedProgress(weights, 2, 0.5, 3)).toBeCloseTo(0.7);
    expect(weightedProgress(weights, 2, 1, 3)).toBe(1);
    // By count, the start of chapter 2 would read 66.7%; by size it is 40%.
    expect(weightedProgress(null, 2, 0, 3)).toBeCloseTo(2 / 3);
  });

  it('falls back to counting chapters when sizes are missing, empty, all zero or invalid', () => {
    expect(weightedProgress(null, 1, 0.5, 4)).toBeCloseTo(0.375);
    expect(weightedProgress([], 1, 0.5, 4)).toBeCloseTo(0.375);
    expect(weightedProgress([0, 0, 0], 1, 0.5, 4)).toBeCloseTo(0.375);
    expect(weightedProgress([10, Number.NaN, 5], 1, 0.5, 4)).toBeCloseTo(0.375);
    expect(weightedProgress([10, -5, 5], 1, 0.5, 4)).toBeCloseTo(0.375);
  });

  it('clamps: an out-of-range chapter or fraction never leaves 0..1', () => {
    expect(weightedProgress(weights, 99, 0.5, 3)).toBeLessThanOrEqual(1);
    expect(weightedProgress(weights, -4, -1, 3)).toBe(0);
    expect(weightedProgress(weights, 1, 7, 3)).toBeCloseTo(0.4);
    expect(weightedProgress(null, 0, Number.NaN, 0)).toBe(0);
  });

  it('is monotonic through a 1,000-chapter book', () => {
    const many = Array.from({ length: 1000 }, (_, i) => 1 + (i % 7) * 500);
    let last = -1;
    for (let c = 0; c < 1000; c += 37) {
      const p = weightedProgress(many, c, 0.3, 1000);
      expect(p).toBeGreaterThan(last);
      last = p;
    }
  });
});
