import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LibraryFile } from '../lib/libraryFolder';
import { bookKey } from '../lib/readingPosition';
import { MAX_MOUNTED_PX } from '../lib/mountWindow';

// A long PDF in the reader: only the pages near the reader are extracted and mounted (the same window as an EPUB), a jump to any
// page extracts that page on demand, and a saved position still restores. ReaderScreen against a fake 3,000-page PDF whose layout
// is modelled exactly: every page is 2,000px tall and stacks from the first one mounted, with no scroll anchoring from the
// browser, so only the reader's own compensation keeps the text still when pages are mounted or removed above the reader.

const store = new Map<string, string>();

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => void store.set(key, value)),
    remove: vi.fn(async ({ key }: { key: string }) => void store.delete(key)),
  },
}));
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: async () => {} })), exitApp: vi.fn() },
}));
vi.mock('../lib/fileBridge', () => ({
  FileTooLargeError: class extends Error {},
  createFileSource: async () => ({ size: 1, read: async () => new Uint8Array(1) }),
}));

vi.setConfig({ testTimeout: 30_000 });

const PAGES = 3000;
const H = 2000;
const VH = 800;

const fake = vi.hoisted(() => ({
  loaded: [] as number[],
  scanned: false,
  /** Pages whose extraction waits for release(). */
  gate: new Map<number, Promise<void>>(),
  destroyed: 0,
  cancelled: 0,
  outline: true,
}));

function pageHtml(index: number): { html: string; pageKind: 'text' | 'raster' } {
  if (fake.scanned) {
    return { html: `<figure class="pdf-page" id="pdf-page-${index + 1}" style="aspect-ratio:1/1"><img class="pdf-page-img" alt="" draggable="false"/></figure>`, pageKind: 'raster' };
  }
  return { html: `<p>PG_${index} a</p><p>PG_${index} b</p>`, pageKind: 'text' };
}

vi.mock('../lib/pdf', () => ({
  openPdf: async () => ({
    title: 'Long PDF',
    numPages: PAGES,
    loadPage: async (index: number) => {
      fake.loaded.push(index);
      const gate = fake.gate.get(index);
      if (gate) await gate;
      return pageHtml(index);
    },
    cancelPending: () => {
      fake.cancelled++;
      return 0;
    },
    streamChapters: async function* (startIndex = 0) {
      yield { type: 'title', title: 'Long PDF' };
      yield { type: 'total', count: PAGES };
      for (let i = startIndex; i < PAGES; i++) {
        fake.loaded.push(i);
        yield { type: 'chapter', ...pageHtml(i) };
      }
    },
    getOutline: async () =>
      fake.outline
        ? [
            { id: 't0', title: 'Start', chapterIndex: 0, depth: 0, children: [] },
            { id: 't1', title: 'Middle', chapterIndex: 1500, depth: 0, children: [] },
            { id: 't2', title: 'Slow one', chapterIndex: 2000, depth: 0, children: [] },
            { id: 't3', title: 'End', chapterIndex: PAGES - 1, depth: 0, children: [] },
          ]
        : [],
    renderPageImage: () => ({ promise: new Promise(() => {}), cancel() {} }),
    destroy: () => {
      fake.destroyed++;
    },
  }),
}));

const file: LibraryFile = { name: 'long.pdf', uri: 'content://x/long.pdf', path: 'long.pdf', size: 99999 };

// jsdom has no IntersectionObserver: this one only keeps track of what is being watched.
const watching = new Set<Element>();
class FakeIntersectionObserver {
  observe(el: Element) {
    watching.add(el);
  }
  unobserve(el: Element) {
    watching.delete(el);
  }
  disconnect() {}
}

let scrollY = 0;
const originalRect = Element.prototype.getBoundingClientRect;
const originalInnerHeight = window.innerHeight;

const pageNumber = (el: Element) => {
  const text = /PG_(\d+)/.exec(el.textContent ?? '')?.[1];
  if (text !== undefined) return Number(text);
  const id = /pdf-page-(\d+)/.exec(el.querySelector('figure')?.id ?? '')?.[1];
  return id !== undefined ? Number(id) - 1 : -1;
};
const mounted = () => Array.from(document.querySelectorAll('.reader-content > section.chapter')).map(pageNumber);
const range = () => {
  const m = mounted();
  return `${m[0]}-${m.at(-1)}`;
};
const readingY = () => mounted()[0] * H + scrollY;

function stubLayout() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 360, width: 360, height, x: 0, y: top, toJSON: () => ({}) });
    const chapter = this.classList.contains('chapter') ? this : this.closest('.chapter');
    if (!chapter?.parentElement) return rect(0, 0);
    const first = pageNumber(chapter.parentElement.querySelector(':scope > .chapter')!);
    const top = (pageNumber(chapter) - first) * H - scrollY;
    if (chapter === this) return rect(top, H);
    const blocks = Array.from(chapter.children);
    const blockHeight = H / Math.max(1, blocks.length);
    return rect(top + Math.max(0, blocks.indexOf(this as Element)) * blockHeight, blockHeight);
  };
}

beforeEach(() => {
  store.clear();
  scrollY = 0;
  fake.loaded.length = 0;
  fake.scanned = false;
  fake.gate.clear();
  fake.destroyed = 0;
  fake.cancelled = 0;
  fake.outline = true;
  watching.clear();
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  Object.defineProperty(window, 'innerHeight', { value: VH, configurable: true, writable: true });
  Object.defineProperty(window, 'scrollY', { get: () => scrollY, configurable: true });
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), load: async () => [] }, configurable: true });
  window.scrollTo = vi.fn((arg: ScrollToOptions | number) => {
    if (typeof arg === 'object' && typeof arg.top === 'number') scrollY = arg.top;
  }) as unknown as typeof window.scrollTo;
  window.scrollBy = vi.fn((arg: ScrollToOptions | number) => {
    if (typeof arg === 'object' && typeof arg.top === 'number') scrollY += arg.top;
  }) as unknown as typeof window.scrollBy;
  stubLayout();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Element.prototype.getBoundingClientRect = originalRect;
  Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true, writable: true });
  vi.restoreAllMocks();
});

function savePositionJson(chapterIndex: number, blockIndex = 0, blockFraction = 0) {
  store.set(`reading_position:${bookKey(file)}`, JSON.stringify({ anchor: { chapterIndex, blockIndex, blockFraction }, anchorVersion: 2, name: file.name, size: file.size, savedAt: 1700000000000 }));
}

async function renderReader(onBack = () => {}) {
  const { default: ReaderScreen } = await import('./ReaderScreen');
  const view = render(<ReaderScreen file={file} onBack={onBack} />);
  await waitFor(() => {
    expect(view.container.querySelector('.reader-content')).not.toBeNull();
    expect(view.container.querySelector('.reader-content.pre-reveal')).toBeNull();
  });
  await settle();
  return view;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function settle() {
  let last = '';
  let stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    await act(async () => {
      await frame();
      await Promise.resolve();
      await Promise.resolve();
    });
    stable = range() === last ? stable + 1 : 0;
    last = range();
  }
}

async function readTo(y: number) {
  const first = mounted()[0];
  scrollY = Math.min(Math.max(y - first * H, 0), mounted().length * H - VH);
  await act(async () => {
    window.dispatchEvent(new Event('scroll'));
  });
  await settle();
}

async function flingTo(y: number) {
  for (let i = 0; i < 200 && Math.abs(readingY() - y) > 1; i++) {
    const before = readingY();
    await readTo(y);
    if (readingY() === before) break;
  }
}

async function jumpTo(title: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
  fireEvent.click(await screen.findByRole('button', { name: title }));
}

describe('ReaderScreen - a long PDF reads only the pages near the reader', () => {
  it('opens a 3,000-page PDF mounting and extracting a handful of pages, not all of them', async () => {
    await renderReader();
    expect(mounted().length).toBeLessThanOrEqual(12);
    expect(mounted()[0]).toBe(0);
    expect(mounted().length * H).toBeLessThan(MAX_MOUNTED_PX);
    expect(Math.max(...fake.loaded)).toBeLessThanOrEqual(15); // pages 16 to 3,000 were never extracted
    expect(new Set(fake.loaded).size).toBe(fake.loaded.length); // none twice
  });

  it('reading on extracts pages as the reader nears them, and the page stays short however far down it goes', async () => {
    await renderReader();
    for (let y = 1500; y <= 60 * H; y += 1500) {
      await readTo(y);
      expect(readingY()).toBeCloseTo(y, 0); // the text never moved when pages were mounted or unmounted
      expect(mounted()).toContain(Math.floor(y / H));
      expect(mounted().length).toBeLessThanOrEqual(12);
    }
    expect(mounted()[0]).toBeGreaterThan(30); // the pages left behind are not in the page
    expect(Math.max(...fake.loaded)).toBeLessThanOrEqual(80); // nothing beyond what the reader could reach was extracted
  });

  it('a very long PDF cannot build a page taller than the cap: a fling down to page 150 carries a window there and nowhere else', async () => {
    await renderReader();
    await flingTo(150 * H);
    expect(mounted()).toContain(150);
    expect(mounted().length * H).toBeLessThan(MAX_MOUNTED_PX);
    expect(readingY()).toBeCloseTo(150 * H, 0);
    expect(Math.max(...fake.loaded)).toBeLessThan(170); // the pages after it were not extracted
  });

  it('the pages the loader watches follow the window, not the PDF', async () => {
    fake.scanned = true;
    await renderReader();
    await flingTo(400 * H);
    expect(watching.size).toBeGreaterThan(0);
    expect(watching.size).toBeLessThanOrEqual(2 * mounted().length); // each page is watched by two observers
    expect(Math.min(...Array.from(watching).map((el) => Number(/pdf-page-(\d+)/.exec((el as HTMLElement).id)![1])))).toBeGreaterThan(300);
  });
});

describe('ReaderScreen - jumping to a PDF page', () => {
  it('a jump to the last page is instant: the page is extracted on demand, with no wait bar, and nothing in between is read', async () => {
    await renderReader();
    fake.loaded.length = 0;
    await jumpTo('End');
    await waitFor(() => expect(mounted()).toContain(PAGES - 1));
    await settle();
    expect(document.querySelector('.toc-wait')).toBeNull();
    expect(document.querySelector('.restore-overlay')).toBeNull();
    expect(Math.min(...fake.loaded)).toBeGreaterThanOrEqual(PAGES - 5);
    expect(fake.loaded[0]).toBe(PAGES - 1); // the target page is the first one extracted
    expect(mounted().length * H).toBeLessThan(MAX_MOUNTED_PX);
    expect(readingY()).toBeGreaterThanOrEqual((PAGES - 1) * H - 1);
    // the new place is saved
    await waitFor(() => {
      const saved = [...store.entries()].find(([k]) => k.startsWith('reading_position:'));
      expect(saved && JSON.parse(saved[1]).anchor.chapterIndex).toBe(PAGES - 1);
    }, { timeout: 4000 });
  });

  it('jumping to the middle and then back to the first page works the same way, from wherever the reader is', async () => {
    await renderReader();
    await jumpTo('Middle');
    await waitFor(() => expect(mounted()).toContain(1500));
    await settle();
    expect(readingY()).toBeGreaterThanOrEqual(1500 * H - 1);
    await jumpTo('Start');
    await waitFor(() => expect(mounted()).toContain(0));
    await settle();
    expect(readingY()).toBeLessThan(H);
    expect(document.querySelector('.toc-wait')).toBeNull();
  });

  it('a page already mounted is just scrolled to', async () => {
    fake.outline = true;
    await renderReader();
    const before = fake.loaded.length;
    await jumpTo('Start');
    await settle();
    expect(fake.loaded.length).toBe(before);
    expect(fake.cancelled).toBe(0);
  });

  it('a page that is slow to extract shows the "Getting to" bar, which Cancel dismisses without moving the reader', async () => {
    let release!: () => void;
    fake.gate.set(2000, new Promise<void>((resolve) => (release = resolve)));
    await renderReader();
    await jumpTo('Slow one');
    expect(document.querySelector('.toc-wait')).toBeNull(); // not at once: a quick page never flashes it
    await waitFor(() => expect(document.querySelector('.toc-wait')).not.toBeNull(), { timeout: 3000 });
    expect(document.querySelector('.toc-wait')!.textContent).toContain('page 2001');
    const stayed = range();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.querySelector('.toc-wait')).toBeNull();
    release();
    await settle();
    expect(range()).toBe(stayed);
    expect(mounted()).not.toContain(2000);
  });

  it('asks the document to drop the pages nobody needs any more when it jumps', async () => {
    await renderReader();
    await jumpTo('End');
    await waitFor(() => expect(mounted()).toContain(PAGES - 1));
    expect(fake.cancelled).toBeGreaterThan(0);
  });
});

describe('ReaderScreen - a PDF\'s saved position and progress', () => {
  it('a position saved by an earlier version (page index, block, fraction) restores to that page without extracting the pages before it', async () => {
    savePositionJson(1500, 1, 0.5);
    await renderReader();
    expect(mounted()).toContain(1500);
    expect(mounted().length).toBeLessThanOrEqual(12);
    expect(Math.min(...fake.loaded)).toBeGreaterThanOrEqual(1497);
    // half way down the second block of page 1,500
    expect(readingY()).toBeCloseTo(1500 * H + 1.5 * (H / 2), 0);
  });

  it('progress is by page, not by how tall the page is', async () => {
    savePositionJson(1500, 0, 0);
    const onBack = vi.fn();
    await renderReader(onBack);
    fireEvent.click(screen.getByText('Back'));
    await waitFor(() => expect(store.get('reading_progress_index')).toBeDefined());
    const progress = JSON.parse(store.get('reading_progress_index')!)[bookKey(file)].progressFraction;
    expect(progress).toBeCloseTo(1500 / PAGES, 3);
    expect(onBack).toHaveBeenCalled();
  });

  it('the Contents drawer shows the place from the page the reader is on', async () => {
    savePositionJson(1500, 0, 0);
    await renderReader();
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    const dialog = await screen.findByRole('dialog', { name: 'Contents' });
    expect(dialog.querySelector('[aria-current="true"]')?.textContent).toBe('Middle');
  });
});

describe('ReaderScreen - scanned PDFs and releasing the document', () => {
  it('shows the scanned-book notice once enough picture pages have been loaded, however they were loaded', async () => {
    fake.scanned = true;
    await renderReader();
    expect(screen.queryByText(/looks like a scanned book/)).toBeNull(); // 4 pages are not enough to say
    await flingTo(12 * H);
    await waitFor(() => expect(screen.queryByText(/looks like a scanned book/)).not.toBeNull());
  });

  it('closing the book releases the document', async () => {
    const view = await renderReader();
    view.unmount();
    expect(fake.destroyed).toBeGreaterThanOrEqual(1);
  });
});
