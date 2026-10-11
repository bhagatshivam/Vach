import { describe, expect, it } from 'vitest';
import { pushKind, shouldShowScannedNotice, SCANNED_NOTICE_WINDOW_SIZE } from './scannedNotice';
import type { PageKind } from './pdf';

function repeat(kind: PageKind, n: number): PageKind[] {
  return Array.from({ length: n }, () => kind);
}

describe('pushKind', () => {
  it('drops a blank page entirely rather than adding it to the window', () => {
    const window = pushKind(['text', 'text'], 'blank');
    expect(window).toEqual(['text', 'text']);
  });

  it('appends a text/raster page', () => {
    expect(pushKind(['text'], 'raster')).toEqual(['text', 'raster']);
  });

  it('caps the window at SCANNED_NOTICE_WINDOW_SIZE, dropping the oldest entry', () => {
    let window: PageKind[] = repeat('text', SCANNED_NOTICE_WINDOW_SIZE);
    window = pushKind(window, 'raster');
    expect(window).toHaveLength(SCANNED_NOTICE_WINDOW_SIZE);
    expect(window[window.length - 1]).toBe('raster');
    expect(window.filter((k) => k === 'text')).toHaveLength(SCANNED_NOTICE_WINDOW_SIZE - 1);
  });

  it('does not mutate its input array', () => {
    const original: PageKind[] = ['text'];
    pushKind(original, 'raster');
    expect(original).toEqual(['text']);
  });
});

describe('shouldShowScannedNotice', () => {
  it('never fires before the window is full', () => {
    expect(shouldShowScannedNotice(repeat('raster', SCANNED_NOTICE_WINDOW_SIZE - 1))).toBe(false);
  });

  it('fires once >=80% of a full window is raster (an all-scanned book, from the start)', () => {
    expect(shouldShowScannedNotice(repeat('raster', SCANNED_NOTICE_WINDOW_SIZE))).toBe(true);
  });

  it('fires at exactly the 80% boundary (12 of 15)', () => {
    const window = [...repeat('raster', 12), ...repeat('text', 3)];
    expect(shouldShowScannedNotice(window)).toBe(true);
  });

  it('does not fire just under the 80% boundary (11 of 15)', () => {
    const window = [...repeat('raster', 11), ...repeat('text', 4)];
    expect(shouldShowScannedNotice(window)).toBe(false);
  });

  // The required fixture: a normally-illustrated novel with a handful of
  // upfront color plates must not be mistaken for a scanned book. Simulated
  // directly on the window (the streaming/pushKind integration is exercised
  // in ReaderScreen's own behavior, verified separately in real Chromium) -
  // 6 raster pages, then real text streams in behind them.
  it('a 6-images-then-text novel never trips the notice, at any point while streaming', () => {
    let window: PageKind[] = [];
    const pageKinds: PageKind[] = [...repeat('raster', 6), ...repeat('text', 200)];
    for (const kind of pageKinds) {
      window = pushKind(window, kind);
      expect(shouldShowScannedNotice(window)).toBe(false);
    }
  });

  it('a genuinely fully-scanned 300-page book trips the notice once the window fills', () => {
    let window: PageKind[] = [];
    let triggeredAtPage = -1;
    for (let i = 0; i < 300; i++) {
      window = pushKind(window, 'raster');
      if (triggeredAtPage === -1 && shouldShowScannedNotice(window)) triggeredAtPage = i + 1;
    }
    expect(triggeredAtPage).toBe(SCANNED_NOTICE_WINDOW_SIZE);
  });
});
