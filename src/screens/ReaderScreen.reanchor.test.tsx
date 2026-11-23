import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LibraryFile } from '../lib/libraryFolder';

// "Stay on the same passage when the layout changes", end to end through
// ReaderScreen. jsdom has no layout, so a model stands in: every chapter is
// 100px tall at 18px type (scaling with the type size and with `extraScale`,
// which stands in for a narrower column after a rotation) and the viewport top
// is wherever window.scrollY says. The model is only a ruler: what matters is
// WHERE the reader scrolls to afterwards.

const store = new Map<string, string>();

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      store.delete(key);
    }),
  },
}));
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: async () => {} })), exitApp: vi.fn() },
}));

const CHAPTERS = 8;
vi.mock('../lib/epubFile', async () => {
  const { ImageStore } = await import('../lib/imageProcessor');
  return {
  openEpubFile: async () => ({
    images: new ImageStore(),
    close() {},
    title: 'Fixture',
    chapterCount: CHAPTERS,
    loadChapter: async (index: number) => `<p>CH_${index}</p>`,
    stream: async function* (start = 0) {
      yield { type: 'title', title: 'Fixture' };
      yield { type: 'total', count: CHAPTERS };
      for (let i = start; i < CHAPTERS; i++) yield { type: 'chapter', html: `<p>CH_${i}</p>` };
    },
  }),
  };
});

const file: LibraryFile = { name: 'book.epub', uri: 'content://x/book.epub', path: 'book.epub', size: 4242 };

const model = { scrollY: 0, extraScale: 1 };
const scrollToCalls: number[] = [];
const originalRect = Element.prototype.getBoundingClientRect;
let resizeCallback: ResizeObserverCallback | null = null;

function fontScale(el: Element): number {
  const content = el.closest('.reader-content') as HTMLElement | null;
  const px = content ? parseFloat(content.style.fontSize) : 18;
  return (px / 18) * model.extraScale;
}

beforeEach(() => {
  store.clear();
  scrollToCalls.length = 0;
  model.scrollY = 0;
  model.extraScale = 1;
  resizeCallback = null;

  Object.defineProperty(window, 'scrollY', { get: () => model.scrollY, configurable: true });
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), load: async () => [] }, configurable: true });
  vi.spyOn(window, 'scrollTo').mockImplementation(((arg: unknown) => {
    const top = typeof arg === 'object' && arg !== null ? (arg as { top: number }).top : (arg as number);
    scrollToCalls.push(top);
    model.scrollY = top;
  }) as typeof window.scrollTo);
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {}
    },
  );

  Element.prototype.getBoundingClientRect = function (this: Element) {
    const section = this.classList.contains('chapter') ? this : this.closest('.chapter');
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) });
    if (!section || !section.parentElement) return rect(0, 0);
    const height = 100 * fontScale(section);
    const index = Array.from(section.parentElement.children).filter((c) => c.classList.contains('chapter')).indexOf(section);
    return rect(index * height - model.scrollY, height);
  };
});

afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = originalRect;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openReader() {
  const { default: ReaderScreen } = await import('./ReaderScreen');
  const view = render(<ReaderScreen file={file} onBack={() => {}} />);
  await waitFor(() => expect(view.container.querySelectorAll('.reader-content > section.chapter')).toHaveLength(CHAPTERS));
  await waitFor(() => expect(view.container.querySelector('.loading-more')).toBeNull());
  return view;
}

describe('ReaderScreen - staying on the same passage when the layout changes', () => {
  it('after a font-size change, scrolls to where the captured passage now is', async () => {
    await openReader();
    model.scrollY = 250; // the viewport top is half way down chapter 2 (200..300 at 18px)

    fireEvent.click(screen.getByText('Aa'));
    fireEvent.click(screen.getByText('A+')); // 18 -> 19px: every chapter is now 105.56px tall

    // chapter 2 at 19px spans 211.1..316.7; half way down it is 263.9
    await waitFor(() => expect(scrollToCalls.length).toBeGreaterThan(0));
    await waitFor(() => expect(model.scrollY).toBeCloseTo(2.5 * (100 * 19) / 18, 1));
  });

  it('captures the position BEFORE the change applies, not after the layout has moved', async () => {
    await openReader();
    model.scrollY = 250;
    fireEvent.click(screen.getByText('Aa'));
    fireEvent.click(screen.getByText('A+'));
    fireEvent.click(screen.getByText('A+'));
    fireEvent.click(screen.getByText('A+')); // 18 -> 21px, three taps in quick succession
    // Restored to the passage from before the FIRST tap (chapter 2, half way), at 21px.
    await waitFor(() => expect(model.scrollY).toBeCloseTo(2.5 * (100 * 21) / 18, 1));
  });

  it('after a line-height or theme change, also restores (both can move text)', async () => {
    await openReader();
    model.scrollY = 250;
    fireEvent.click(screen.getByText('Aa'));
    // A theme change does not change the model's heights, so the restore target is the same place:
    // nothing to correct, and it must not scroll away from it.
    fireEvent.click(screen.getByText('Night'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(model.scrollY).toBeCloseTo(250, 1);
  });

  it('after a rotation (the reader column changes width), restores to the passage from just before it', async () => {
    const view = await openReader();
    // The reader was resting on chapter 2, half way down, long enough for the position to be remembered.
    model.scrollY = 250;
    fireEvent.scroll(window);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Rotate: the column gets narrower, text reflows taller (1.5x), the scroll offset is unchanged.
    model.extraScale = 1.5;
    expect(resizeCallback).not.toBeNull();
    resizeCallback!([{ contentRect: { width: 640 } } as ResizeObserverEntry], {} as ResizeObserver);

    await waitFor(() => expect(model.scrollY).toBeCloseTo(2.5 * 150, 1), { timeout: 2000 });
    expect(view.container.querySelectorAll('.reader-content > section.chapter')).toHaveLength(CHAPTERS);
  });
});
