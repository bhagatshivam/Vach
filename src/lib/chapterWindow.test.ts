import { describe, expect, it } from 'vitest';
import {
  PREPEND_TRIGGER_VIEWPORTS,
  RESTORE_CONTEXT_CHAPTERS,
  prependCompensation,
  restoreWindowStart,
  shouldLoadPrevious,
  toAbsoluteAnchor,
  toDomAnchor,
} from './chapterWindow';

describe('restoreWindowStart', () => {
  it('starts one chapter before the saved one, for context', () => {
    expect(RESTORE_CONTEXT_CHAPTERS).toBe(1);
    expect(restoreWindowStart(500, 1000)).toBe(499);
    expect(restoreWindowStart(2, 10)).toBe(1);
  });

  it('never goes below chapter 0', () => {
    expect(restoreWindowStart(0, 10)).toBe(0);
    expect(restoreWindowStart(1, 10)).toBe(0);
    expect(restoreWindowStart(-5, 10)).toBe(0);
  });

  it('clamps a stale saved index past the end to the last chapter', () => {
    expect(restoreWindowStart(9999, 1000)).toBe(998); // last chapter 999, minus context
    expect(restoreWindowStart(10, 10)).toBe(8);
  });

  it('handles tiny and empty books', () => {
    expect(restoreWindowStart(0, 1)).toBe(0);
    expect(restoreWindowStart(7, 1)).toBe(0);
    expect(restoreWindowStart(3, 0)).toBe(0);
  });
});

describe('anchor translation (book index <-> mounted window)', () => {
  const saved = { chapterIndex: 500, blockIndex: 12, blockFraction: 0.25 };

  it('a saved anchor maps to the right chapter in the window and keeps its block position', () => {
    // Window starts at 499, five chapters mounted: 499..503.
    expect(toDomAnchor(saved, 499, 5)).toEqual({ chapterIndex: 1, blockIndex: 12, blockFraction: 0.25 });
  });

  it('round-trips: DOM anchor + first index gives back the book anchor', () => {
    const dom = toDomAnchor(saved, 499, 5);
    expect(toAbsoluteAnchor(dom, 499)).toEqual(saved);
  });

  it('a window that starts at 0 is the identity (so books opened from the start behave as before)', () => {
    expect(toDomAnchor(saved, 0, 1000)).toEqual(saved);
    expect(toAbsoluteAnchor(saved, 0)).toEqual(saved);
  });

  it('clamps a stale anchor into what is mounted, without touching the block fields', () => {
    const stale = { chapterIndex: 9999, blockIndex: 3, blockFraction: 0.5 };
    expect(toDomAnchor(stale, 10, 4)).toEqual({ chapterIndex: 3, blockIndex: 3, blockFraction: 0.5 });
    const before = { chapterIndex: 2, blockIndex: 3, blockFraction: 0.5 };
    expect(toDomAnchor(before, 10, 4)).toEqual({ chapterIndex: 0, blockIndex: 3, blockFraction: 0.5 });
    expect(toDomAnchor(stale, 0, 0).chapterIndex).toBe(0);
  });

  it('a position measured in the DOM is saved in book terms, whatever is mounted', () => {
    // Reader is in the 3rd mounted chapter of a window that starts at book chapter 7.
    expect(toAbsoluteAnchor({ chapterIndex: 2, blockIndex: 4, blockFraction: 0.1 }, 7).chapterIndex).toBe(9);
  });
});

describe('shouldLoadPrevious', () => {
  it('loads earlier chapters when within two viewports of the top of what is mounted', () => {
    expect(PREPEND_TRIGGER_VIEWPORTS).toBe(2);
    expect(shouldLoadPrevious(0, 800, 5)).toBe(true);
    expect(shouldLoadPrevious(1599, 800, 5)).toBe(true);
  });

  it('does not load while the reader is further down', () => {
    expect(shouldLoadPrevious(1600, 800, 5)).toBe(false);
    expect(shouldLoadPrevious(50_000, 800, 5)).toBe(false);
  });

  it('never loads when chapter 0 is already mounted', () => {
    expect(shouldLoadPrevious(0, 800, 0)).toBe(false);
  });
});

describe('prependCompensation', () => {
  it('scrolls down by exactly how far the content moved down', () => {
    expect(prependCompensation(120, 920)).toBe(800);
  });

  it('is zero when the browser already compensated', () => {
    expect(prependCompensation(120, 120)).toBe(0);
  });
});
