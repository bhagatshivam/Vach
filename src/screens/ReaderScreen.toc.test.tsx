import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import type { LibraryFile } from '../lib/libraryFolder';
import type { TocItem } from '../lib/toc';

// The Contents drawer through the whole reader: the button appears only when there is a TOC, the current
// entry is highlighted from the live position, tapping an entry jumps (scrolling when the chapter is
// mounted, reopening the window at it when not, waiting visibly for a PDF page not extracted yet), the
// new position is saved, and Back closes the drawer before leaving the book.

const store = vi.hoisted(() => ({
  prefs: new Map<string, string>(),
  openCount: 0,
  streamStarts: [] as number[],
  yielded: [] as number[][],
  chapterCount: 6,
  toc: [] as unknown[],
  gate: null as null | { after: number; promise: Promise<void> },
  pdf: null as null | { pages: number; gateAfter: number; gate: Promise<void>; outline: unknown[] },
}));

vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ apply: async () => {} }) }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.prefs.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => void store.prefs.set(key, value)),
    remove: vi.fn(async ({ key }: { key: string }) => void store.prefs.delete(key)),
  },
}));
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: async () => {} })), exitApp: vi.fn() },
}));

const chapterHtml = (i: number) => (i === 3 ? `<h2 data-vach-anchor="sec">Heading ${i}</h2><p>body ${i}</p>` : `<p>chapter ${i}</p>`);

vi.mock('../lib/epubFile', async () => {
  const { ImageStore } = await import('../lib/imageProcessor');
  return {
    openEpubFile: async () => {
      store.openCount++;
      const first = store.openCount === 1;
      return {
        images: new ImageStore(),
        close() {},
        title: 'Long Book',
        chapterCount: store.chapterCount,
        chapterWeights: null,
        toc: async () => store.toc,
        loadChapter: async (i: number) => chapterHtml(i),
        stream: async function* (startIndex = 0) {
          store.streamStarts.push(startIndex);
          const got: number[] = [];
          store.yielded.push(got);
          yield { type: 'title', title: 'Long Book' };
          yield { type: 'total', count: store.chapterCount };
          for (let i = startIndex; i < store.chapterCount; i++) {
            if (first && store.gate && i > store.gate.after) await store.gate.promise;
            got.push(i);
            yield { type: 'chapter', html: chapterHtml(i) };
          }
        },
      };
    },
  };
});

vi.mock('../lib/fileBridge', () => ({
  FileTooLargeError: class extends Error {},
  createFileSource: async () => ({ size: 1, read: async () => new Uint8Array(1) }),
}));
vi.mock('../lib/pdf', () => ({
  openPdf: async () => {
    const pdf = store.pdf!;
    return {
      destroy() {},
      renderPageImage: () => ({ promise: new Promise(() => {}), cancel() {} }),
      getOutline: async () => pdf.outline,
      streamChapters: async function* () {
        yield { type: 'title', title: 'A PDF' };
        yield { type: 'total', count: pdf.pages };
        for (let i = 0; i < pdf.pages; i++) {
          if (i > pdf.gateAfter) await pdf.gate;
          yield { type: 'chapter', html: `<p>page ${i + 1}</p>`, pageKind: 'text' };
        }
      },
    };
  },
}));

import { savePosition, __resetForTests } from '../lib/readingPosition';
import { Preferences } from '@capacitor/preferences';

const epubFile: LibraryFile = { name: 'long.epub', uri: 'content://x/long.epub', path: 'long.epub', size: 9999 };
const pdfFile: LibraryFile = { name: 'doc.pdf', uri: 'content://x/doc.pdf', path: 'doc.pdf', size: 8888 };

const item = (id: string, title: string, chapterIndex: number, fragment?: string, depth = 0, children: TocItem[] = []): TocItem => ({ id, title, chapterIndex, fragment, depth, children });

let scrollY = 0;
// How tall each mocked chapter is; a test makes them enormous to put the last chapters far down a very tall page.
let chapterHeight = 100;
const scrollTo = vi.fn();
const originalRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  // The PDF page loader watches placeholders with an IntersectionObserver, which jsdom lacks.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  store.prefs.clear();
  store.openCount = 0;
  store.streamStarts = [];
  store.yielded = [];
  store.chapterCount = 6;
  store.toc = [];
  store.gate = null;
  store.pdf = null;
  __resetForTests();
  scrollY = 0;
  chapterHeight = 100;
  scrollTo.mockReset();
  scrollTo.mockImplementation((arg: ScrollToOptions | number) => {
    if (typeof arg === 'object' && typeof arg.top === 'number') scrollY = arg.top;
  });
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), load: async () => [] }, configurable: true });
  Object.defineProperty(window, 'scrollY', { get: () => scrollY, configurable: true });
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  // Compensating for chapters prepended above the reader moves the scroll position, as in a browser.
  window.scrollBy = vi.fn((arg: ScrollToOptions | number) => {
    if (typeof arg === 'object' && typeof arg.top === 'number') scrollY += arg.top;
  }) as unknown as typeof window.scrollBy;
  // Chapter i is 100px tall and starts at i * 100 (minus the scroll); an anchor element sits 40px into its chapter.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 360, width: 360, height, x: 0, y: top, toJSON: () => ({}) });
    const chapter = this.classList.contains('chapter') ? this : this.closest('.chapter');
    if (chapter) {
      // Which chapter this is comes from its text ("chapter 4", "page 5"), so it stays right when earlier chapters are
      // prepended. Chapters stack from the first one mounted, like the real page.
      const indexOf = (el: Element) => {
        const match = /(?:chapter|body|Heading) (\d+)|page (\d+)/.exec(el.textContent ?? '');
        return match ? (match[1] !== undefined ? Number(match[1]) : Number(match[2]) - 1) : 0;
      };
      const firstMounted = indexOf(chapter.parentElement!.querySelector(':scope > .chapter')!);
      const top = (indexOf(chapter) - firstMounted) * chapterHeight - scrollY + (this.hasAttribute('data-vach-anchor') ? 40 : 0);
      return rect(top, this === chapter ? chapterHeight : this.hasAttribute('data-vach-anchor') ? 20 : chapterHeight);
    }
    return rect(0, 0);
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  Element.prototype.getBoundingClientRect = originalRect;
  vi.restoreAllMocks();
});

async function openEpubReader(options: { toc?: TocItem[]; onBack?: () => void; savedChapter?: number } = {}) {
  store.toc = options.toc ?? [];
  if (options.savedChapter !== undefined) await savePosition(epubFile, { chapterIndex: options.savedChapter, blockIndex: 0, blockFraction: 0 }, 0.5);
  const overlayCloseRef = createRef<(() => void) | null>() as { current: (() => void) | null };
  const { default: ReaderScreen } = await import('./ReaderScreen');
  const view = render(<ReaderScreen file={epubFile} onBack={options.onBack ?? (() => {})} overlayCloseRef={overlayCloseRef} />);
  await waitFor(() => expect(view.container.querySelector('.reader-content:not(.pre-reveal) .chapter')).not.toBeNull());
  // Only the first few chapters are mounted at once and the window manager brings in the rest a frame at a time: a short
  // book is whole once it has settled, and a jump to one of its chapters is then a plain scroll, not a reopen.
  if (options.savedChapter === undefined && store.chapterCount <= 8 && chapterHeight <= 100) {
    await waitFor(() => expect(view.container.querySelectorAll('.reader-content .chapter')).toHaveLength(store.chapterCount));
  }
  return { view, overlayCloseRef };
}

const LONG_TOC = [item('t0', 'Prologue', 0), item('t1', 'Chapter One', 1), item('t2', 'Chapter Two', 2), item('t3', 'The Heading', 3, 'sec'), item('t4', 'Chapter Four', 4), item('t5', 'Epilogue', 5)];

describe('ReaderScreen - the Contents button', () => {
  it('is hidden when the book has no table of contents (or a single entry)', async () => {
    await openEpubReader({ toc: [] });
    expect(screen.queryByRole('button', { name: 'Contents' })).toBeNull();
    cleanup();
    await openEpubReader({ toc: [item('only', 'Only', 0)] });
    expect(screen.queryByRole('button', { name: 'Contents' })).toBeNull();
  });

  it('appears once the book has a table of contents, and opens the drawer', async () => {
    await openEpubReader({ toc: LONG_TOC });
    const button = await screen.findByRole('button', { name: 'Contents' });
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Contents' });
    expect(within(dialog).getByRole('button', { name: 'Epilogue' })).toBeTruthy();
    expect(within(dialog).getByRole('progressbar')).toBeTruthy();
  });
});

describe('ReaderScreen - current entry and progress', () => {
  it('highlights the entry for the chapter the reader is in, measured when the drawer opens', async () => {
    await openEpubReader({ toc: LONG_TOC });
    scrollY = 250; // inside chapter 2 (200..300)
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    const dialog = await screen.findByRole('dialog', { name: 'Contents' });
    expect(dialog.querySelector('[aria-current="true"]')!.textContent).toBe('Chapter Two');
  });
});

describe('ReaderScreen - jumping to a chapter that is already mounted', () => {
  it('scrolls to its start, closes the drawer, hides the bar and saves the new position', async () => {
    await openEpubReader({ toc: LONG_TOC });
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Chapter Four' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Contents' })).toBeNull());
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 400 }));
    expect(document.querySelector('.reader-header')!.classList.contains('hidden')).toBe(true);
    await waitFor(() => {
      const saved = [...store.prefs.entries()].find(([k]) => k.startsWith('reading_position:'));
      expect(saved && JSON.parse(saved[1]).anchor.chapterIndex).toBe(4);
    });
    // The book was not reopened and no earlier chapter was parsed again.
    expect(store.openCount).toBe(1);
    expect(store.streamStarts).toEqual([0]);
  });

  it('scrolls to the fragment when the chapter has it, and to the chapter start when it does not', async () => {
    await openEpubReader({ toc: [...LONG_TOC, item('t6', 'Missing spot', 3, 'nope')] });
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'The Heading' }));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 340 })));

    scrollTo.mockClear();
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Missing spot' }));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 300 })));
    expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ top: 340 }));
  });
});

describe('ReaderScreen - jumping outside the mounted window (EPUB)', () => {
  const BIG_TOC = [item('a', 'Early', 3), item('b', 'Middle', 40), item('c', 'Late', 55)];

  it('backward: reopens the window at the target, parsing nothing before it, and saves that position', async () => {
    store.chapterCount = 60;
    await openEpubReader({ toc: BIG_TOC, savedChapter: 40 });
    expect(store.streamStarts).toEqual([39]);

    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Early' }));

    await waitFor(() => expect(store.streamStarts).toEqual([39, 2])); // chapter 3, one chapter of context
    // Nothing earlier than the window start was ever yielded by the new stream.
    expect(Math.min(...store.yielded[1])).toBe(2);
    expect(store.openCount).toBe(2);
    await waitFor(() => {
      const saved = [...store.prefs.entries()].find(([k]) => k.startsWith('reading_position:'));
      expect(saved && JSON.parse(saved[1]).anchor.chapterIndex).toBe(3);
    }, { timeout: 4000 });
    expect(screen.queryByRole('dialog', { name: 'Contents' })).toBeNull();
  });

  it('forward, past what has streamed in so far: reopens at the target instead of waiting for every chapter between', async () => {
    store.chapterCount = 60;
    let release!: () => void;
    store.gate = { after: 42, promise: new Promise<void>((resolve) => (release = resolve)) };
    await openEpubReader({ toc: BIG_TOC, savedChapter: 40 });
    await waitFor(() => expect(store.yielded[0].at(-1)).toBe(42));

    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Late' }));

    await waitFor(() => expect(store.streamStarts).toEqual([39, 54]));
    expect(Math.min(...store.yielded[1])).toBe(54);
    release();
  });
});

describe('ReaderScreen - a chapter far down a very tall book (the last chapters of a long book)', () => {
  // Chromium paints nothing past ~2^23 px of scroll offset. Only a window of chapters around the reader is mounted
  // (mountWindow.ts), so the page is never that tall and the last chapters of a long book are not on it: a jump to one
  // reopens the window at it, which puts it near the top of a short page. A chapter that is in the window is just scrolled to.
  const mountedCount = () => document.querySelectorAll('.reader-content .chapter').length;

  it('the page holds a window of the book, not all of it; a chapter that is not mounted reopens the window at it', async () => {
    chapterHeight = 500_000; // chapter 5 would start 2.5M px down
    await openEpubReader({ toc: LONG_TOC });
    await waitFor(() => expect(mountedCount()).toBeLessThan(6)); // the chapters far below the screen are not mounted
    scrollTo.mockClear();

    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Epilogue' }));

    await waitFor(() => expect(store.streamStarts).toEqual([0, 4])); // chapter 5, one chapter of context
    expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ top: 2_500_000 }));
    expect(store.openCount).toBe(2);
    // The reopened window holds the target and starts right before it - not the whole book.
    await waitFor(() => expect(document.querySelectorAll('.reader-content:not(.pre-reveal) .chapter')).toHaveLength(2));
    expect(Math.min(...store.yielded[1])).toBe(4);
    await waitFor(() => {
      const saved = [...store.prefs.entries()].find(([k]) => k.startsWith('reading_position:'));
      expect(saved && JSON.parse(saved[1]).anchor.chapterIndex).toBe(5);
    }, { timeout: 4000 });
  });

  it('a chapter that is in the window is still just scrolled to (no reopening)', async () => {
    chapterHeight = 2_000; // chapters 0-3 are all within the window of a 768px screen: chapter 2 starts 4,000px down
    await openEpubReader({ toc: LONG_TOC });
    await waitFor(() => expect(mountedCount()).toBeGreaterThanOrEqual(4));
    scrollTo.mockClear();

    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Chapter Two' }));

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 4_000 })));
    expect(store.openCount).toBe(1);
    expect(store.streamStarts).toEqual([0]);
  });

  it('jumping to the last chapter and then back to the first both end with the target mounted', async () => {
    chapterHeight = 500_000;
    await openEpubReader({ toc: LONG_TOC });
    await waitFor(() => expect(mountedCount()).toBeLessThan(6));

    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Epilogue' }));
    await waitFor(() => expect(document.querySelector('.reader-content:not(.pre-reveal)')?.textContent).toContain('chapter 5'));

    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Prologue' }));
    // Chapter 0 is not mounted in the window that starts at 4, so the window is reopened at it again.
    await waitFor(() => expect(store.streamStarts.at(-1)).toBe(0));
    await waitFor(() => expect(document.querySelector('.reader-content:not(.pre-reveal)')?.textContent).toContain('chapter 0'));
  });
});

describe('ReaderScreen - the last chapter is short or the only one', () => {
  it('a saved position in the (short) last chapter restores with that chapter mounted and revealed', async () => {
    await openEpubReader({ toc: LONG_TOC, savedChapter: 5 });
    expect(store.streamStarts).toEqual([4]);
    expect(document.querySelector('.reader-content:not(.pre-reveal)')?.textContent).toContain('chapter 5');
    expect(document.querySelector('.restore-overlay')).toBeNull();
  });

  it('a one-chapter book opens, shows its chapter and has no Contents button', async () => {
    store.chapterCount = 1;
    await openEpubReader({ toc: [item('only', 'Only', 0)] });
    expect(document.querySelector('.reader-content:not(.pre-reveal)')?.textContent).toContain('chapter 0');
    expect(screen.queryByRole('button', { name: 'Contents' })).toBeNull();
  });
});

describe('ReaderScreen - hardware Back and tapping outside', () => {
  it('Back closes the drawer first and does not leave the book; the hook is cleared afterwards', async () => {
    const onBack = vi.fn();
    const { overlayCloseRef } = await openEpubReader({ toc: LONG_TOC, onBack });
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    await screen.findByRole('dialog', { name: 'Contents' });

    expect(overlayCloseRef.current).toBeTypeOf('function');
    act(() => overlayCloseRef.current!());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Contents' })).toBeNull());
    expect(onBack).not.toHaveBeenCalled();
    expect(overlayCloseRef.current).toBeNull();
  });

  it('tapping outside the panel closes it without jumping', async () => {
    const { view } = await openEpubReader({ toc: LONG_TOC });
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    await screen.findByRole('dialog', { name: 'Contents' });
    scrollTo.mockClear();
    fireEvent.click(view.container.ownerDocument.querySelector('.toc-backdrop')!);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Contents' })).toBeNull());
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('ReaderScreen - a PDF with an outline', () => {
  // 8 pages. The reader shows the first four together and the rest as they arrive.
  const OUTLINE = [item('p0', 'Cover', 0), item('p1', 'Part One', 1), item('p7', 'Part Two', 7)];

  async function openPdfReader(gateAfter: number) {
    let release!: () => void;
    store.pdf = { pages: 8, gateAfter, gate: new Promise<void>((resolve) => (release = resolve)), outline: OUTLINE };
    const { default: ReaderScreen } = await import('./ReaderScreen');
    const view = render(<ReaderScreen file={pdfFile} onBack={() => {}} />);
    await waitFor(() => expect(view.container.querySelector('.reader-content:not(.pre-reveal) .chapter')).not.toBeNull());
    return { view, release };
  }

  it('shows the outline, and a page that has already been extracted is jumped to at once', async () => {
    await openPdfReader(99);
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Part One' }));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 100 })));
    expect(screen.queryByText(/Getting to/)).toBeNull();
  });

  it('the last page is jumped to when it has already been extracted (a PDF never reopens a window)', async () => {
    await openPdfReader(99);
    await waitFor(() => expect(document.querySelectorAll('.reader-content .chapter')).toHaveLength(8));
    chapterHeight = 500_000; // even a very tall PDF page stack is only ever scrolled
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Part Two' }));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 3_500_000 })));
    expect(screen.queryByText(/Getting to/)).toBeNull();
  });

  it('a page the text pass has not reached yet: a visible, cancelable wait, then it lands there', async () => {
    const { release } = await openPdfReader(5); // pages 1-6 are in; 7-8 are held back
    await waitFor(() => expect(document.querySelectorAll('.reader-content .chapter')).toHaveLength(6));
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Part Two' }));

    const bar = await screen.findByRole('status');
    expect(bar.textContent).toContain('Part Two');
    expect(bar.textContent).toMatch(/page 6 of 8/);
    expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ top: 700 }));

    release();
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 700 })));
    await waitFor(() => expect(screen.queryByText(/Getting to/)).toBeNull());
  });

  it('Cancel stops waiting: the bar goes and the reader does not jump when the page arrives', async () => {
    const { release } = await openPdfReader(5);
    await waitFor(() => expect(document.querySelectorAll('.reader-content .chapter')).toHaveLength(6));
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Part Two' }));
    fireEvent.click(await within(await screen.findByRole('status')).findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Getting to/)).toBeNull();
    scrollTo.mockClear();
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ top: 700 }));
  });
});

it('saved positions still restore exactly as before (no TOC involved)', async () => {
  store.chapterCount = 20;
  await savePosition(epubFile, { chapterIndex: 7, blockIndex: 0, blockFraction: 0 }, 0.3);
  const { default: ReaderScreen } = await import('./ReaderScreen');
  render(<ReaderScreen file={epubFile} onBack={() => {}} />);
  await waitFor(() => expect(store.streamStarts).toEqual([6]));
  expect(Preferences.get).toHaveBeenCalled();
});
