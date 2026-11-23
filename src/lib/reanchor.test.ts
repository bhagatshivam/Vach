import { describe, expect, it } from 'vitest';
import { DEFAULT_READER_SETTINGS } from './readerSettings';
import { anchorScrollTarget, needsScroll, preserveAnchorDuring, settingsAffectLayout, type ScrollPort } from './reanchor';
import type { Rect } from './readerAnchor';

describe('settingsAffectLayout', () => {
  const base = DEFAULT_READER_SETTINGS;

  it.each([
    ['font size', { fontSize: base.fontSize + 2 }],
    ['line height', { lineHeight: base.lineHeight + 0.1 }],
    ['font family', { fontFamily: 'literata' as const }],
    ['theme', { theme: 'night' as const }],
  ])('%s can move text', (_label, patch) => {
    expect(settingsAffectLayout(base, { ...base, ...patch })).toBe(true);
  });

  it('nothing changed: no', () => {
    expect(settingsAffectLayout(base, { ...base })).toBe(false);
  });

  it('custom colors alone do not move text', () => {
    expect(settingsAffectLayout(base, { ...base, customBackground: '#000000', customText: '#ffffff' })).toBe(false);
  });
});

describe('anchorScrollTarget', () => {
  function chapterEls(count: number): HTMLElement[] {
    document.body.innerHTML = Array.from({ length: count }, (_, i) => `<section class="chapter"><p>c${i}a</p><p>c${i}b</p></section>`).join('');
    return Array.from(document.querySelectorAll('section.chapter'));
  }
  // Every <p> is 100px tall, stacked in document order; the page starts `shift` px above the viewport.
  function rects(shift: number) {
    return (el: Element): Rect => {
      const paragraphs = Array.from(document.querySelectorAll('p'));
      const index = paragraphs.indexOf(el as HTMLParagraphElement);
      if (index !== -1) return { top: index * 100 - shift, bottom: index * 100 - shift + 100 };
      const first = paragraphs.indexOf(el.firstElementChild as HTMLParagraphElement);
      return { top: first * 100 - shift, bottom: first * 100 - shift + 200 };
    };
  }

  it('puts the saved block back at the top, wherever the layout moved it', () => {
    const chapters = chapterEls(3);
    const anchor = { chapterIndex: 1, blockIndex: 1, blockFraction: 0.5 }; // second paragraph of chapter 1 = paragraph #3, half way
    // Before the change that paragraph was at document y = 3*100 + 50 = 350; after, everything moved down 40px.
    expect(anchorScrollTarget(chapters, anchor, 0, 0, rects(-40))).toBe(3 * 100 + 40 + 50);
  });

  it('accounts for the current scroll position (rects are viewport-relative)', () => {
    const chapters = chapterEls(2);
    const anchor = { chapterIndex: 0, blockIndex: 1, blockFraction: 0 };
    expect(anchorScrollTarget(chapters, anchor, 0, 500, rects(0))).toBe(100 + 500);
  });

  it('works on a window of the book: the anchor is book-relative, the DOM starts at chapter 7', () => {
    const chapters = chapterEls(2); // book chapters 7 and 8
    const anchor = { chapterIndex: 8, blockIndex: 0, blockFraction: 0 };
    expect(anchorScrollTarget(chapters, anchor, 7, 0, rects(0))).toBe(2 * 100);
  });

  it('clamps a chapter that is no longer (or not yet) mounted to the nearest mounted one', () => {
    const chapters = chapterEls(2);
    expect(anchorScrollTarget(chapters, { chapterIndex: 99, blockIndex: 0, blockFraction: 0 }, 0, 0, rects(0))).toBe(2 * 100);
    expect(anchorScrollTarget(chapters, { chapterIndex: 0, blockIndex: 0, blockFraction: 0 }, 5, 0, rects(0))).toBe(0);
  });

  it('returns null when nothing is mounted', () => {
    expect(anchorScrollTarget([], { chapterIndex: 0, blockIndex: 0, blockFraction: 0 }, 0, 0)).toBeNull();
  });
});

describe('needsScroll', () => {
  it('ignores sub-pixel differences, acts on real ones', () => {
    expect(needsScroll(100, 100.9)).toBe(false);
    expect(needsScroll(100, 98.5)).toBe(false);
    expect(needsScroll(100, 98.4)).toBe(true);
    expect(needsScroll(100, 103)).toBe(true);
  });
});

describe('preserveAnchorDuring', () => {
  // Three 100px paragraphs in one chapter, stacked; `grow` px are inserted above paragraph 2 during the work.
  function setup(startScroll: number) {
    document.body.innerHTML = '<section class="chapter"><p>a</p><p>b</p><p>c</p></section>';
    const chapter = document.querySelector('section.chapter') as HTMLElement;
    const state = { grow: 0, scrollY: startScroll };
    const rectOf = (el: Element): Rect => {
      const paragraphs = Array.from(chapter.querySelectorAll('p'));
      const index = paragraphs.indexOf(el as HTMLParagraphElement);
      if (index === -1) return { top: -state.scrollY, bottom: 300 + state.grow - state.scrollY };
      const top = index * 100 + (index >= 1 ? state.grow : 0) - state.scrollY;
      return { top, bottom: top + 100 };
    };
    const scrolls: number[] = [];
    const scroll: ScrollPort = {
      y: () => state.scrollY,
      scrollTo: (y) => {
        scrolls.push(y);
        state.scrollY = y;
      },
    };
    return { chapter, state, rectOf, scroll, scrolls };
  }

  it('scrolls by exactly what content added above the reader pushed the passage down', () => {
    const { chapter, state, rectOf, scroll, scrolls } = setup(150); // top of viewport is half way down paragraph b
    preserveAnchorDuring(() => [chapter], () => { state.grow = 80; }, scroll, rectOf);
    expect(scrolls).toEqual([230]); // paragraph b moved down 80, so the page follows by 80
  });

  it('does nothing when the work did not move anything', () => {
    const { chapter, rectOf, scroll, scrolls } = setup(150);
    preserveAnchorDuring(() => [chapter], () => {}, scroll, rectOf);
    expect(scrolls).toEqual([]);
  });

  it('still runs the work when there is nothing mounted to anchor to', () => {
    let ran = false;
    preserveAnchorDuring(() => [], () => { ran = true; }, { y: () => 0, scrollTo: () => { throw new Error('should not scroll'); } });
    expect(ran).toBe(true);
  });
});
