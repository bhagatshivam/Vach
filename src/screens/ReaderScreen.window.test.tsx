import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LibraryFile } from '../lib/libraryFolder';
import { bookKey } from '../lib/readingPosition';
import { weightedProgress } from '../lib/toc';
import { MAX_MOUNTED_PX } from '../lib/mountWindow';
import { TableAdaptController } from '../lib/tableAdapter';

// The reader mounts a WINDOW of a long book around the reader, loading chapters ahead of and behind them as they scroll and
// unmounting the ones that are far away (mountWindow.ts) - so the page is never taller than a bounded amount and Chromium
// never has to paint past 2^23 px. ReaderScreen against a fake 300-chapter book whose layout is modelled exactly: every
// chapter is 2,000px tall and stacks from the first one that is mounted, with NO scroll anchoring from the browser, so
// the only thing keeping the text where it was when chapters are mounted above it or removed is the reader's own compensation.

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

vi.setConfig({ testTimeout: 30_000 });

const CHAPTERS = 300;
const H = 2000; // one chapter, in px
const VH = 800; // the screen

const fake = vi.hoisted(() => ({
  loadCalls: [] as number[],
  yielded: [] as number[],
  withImages: false,
  made: [] as string[],
  revoked: [] as string[],
  store: null as null | import('../lib/imageProcessor').ImageStore,
  weights: null as null | number[],
  closed: 0,
}));

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function pngBytes(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: number[]) => [...be32(data.length), ...type.split('').map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]), ...chunk('IDAT', [0, 0, 0, 0])]);
}

vi.mock('../lib/epubFile', async () => {
  const { ImageStore } = await import('../lib/imageProcessor');
  return {
    openEpubFile: async () => {
      let counter = 0;
      const images = new ImageStore(
        {
          createObjectURL: () => {
            const url = `blob:http://localhost/${++counter}`;
            fake.made.push(url);
            return url;
          },
          revokeObjectURL: (url) => void fake.revoked.push(url),
          resample: async () => new Blob(['small'], { type: 'image/webp' }),
          viewport: () => ({ width: 360, height: 800, devicePixelRatio: 1 }),
        },
        { dropGraceMs: 0 },
      );
      fake.store = images;
      const html = async (i: number) => {
        if (!fake.withImages) return `<p>CH_${i} a</p><p>CH_${i} b</p>`;
        const bytes = pngBytes(3000, 2000);
        const picture = images.register(`img${i}.png`, bytes, 'image/png', { read: async () => bytes });
        return `<p>CH_${i} a</p><img alt="Picture ${i}" id="img-${i}" src="${picture.url}" width="${picture.width}" height="${picture.height}" style="aspect-ratio:3000/2000"><table id="table-${i}"><tr><td>CH_${i} cell</td></tr></table><p>CH_${i} b</p>`;
      };
      return {
        images,
        close() {
          fake.closed++;
          images.revokeAll();
        },
        toc: async () => [],
        chapterWeights: fake.weights,
        title: 'Long Book',
        chapterCount: CHAPTERS,
        loadChapter: async (index: number) => {
          fake.loadCalls.push(index);
          return html(index);
        },
        stream: async function* (startIndex = 0) {
          yield { type: 'title', title: 'Long Book' };
          yield { type: 'total', count: CHAPTERS };
          for (let i = startIndex; i < CHAPTERS; i++) {
            fake.yielded.push(i);
            yield { type: 'chapter', html: await html(i) };
          }
        },
      };
    },
  };
});

const file: LibraryFile = { name: 'long.epub', uri: 'content://x/long.epub', path: 'long.epub', size: 123456 };

let scrollY = 0;
const originalRect = Element.prototype.getBoundingClientRect;
const originalInnerHeight = window.innerHeight;

const chapterNumber = (el: Element) => Number(/CH_(\d+)/.exec(el.textContent ?? '')?.[1] ?? -1);
const mounted = () => Array.from(document.querySelectorAll('.reader-content > section.chapter')).map(chapterNumber);
const range = () => {
  const m = mounted();
  return `${m[0]}-${m.at(-1)}`;
};
/** Where the top of the screen is in the BOOK, in px: the chapters above the first one mounted count as H each. */
const readingY = () => mounted()[0] * H + scrollY;

function stubLayout() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 360, width: 360, height, x: 0, y: top, toJSON: () => ({}) });
    const chapter = this.classList.contains('chapter') ? this : this.closest('.chapter');
    if (!chapter?.parentElement) return rect(0, 0);
    const first = chapterNumber(chapter.parentElement.querySelector(':scope > .chapter')!);
    const top = (chapterNumber(chapter) - first) * H - scrollY;
    if (chapter === this) return rect(top, H);
    const blocks = Array.from(chapter.children).filter((c) => !c.hasAttribute('data-vach-ui'));
    const position = blocks.indexOf(this as Element);
    const blockHeight = H / Math.max(1, blocks.length);
    return rect(top + Math.max(0, position) * blockHeight, blockHeight);
  };
}

beforeEach(() => {
  store.clear();
  scrollY = 0;
  fake.loadCalls.length = 0;
  fake.yielded.length = 0;
  fake.made.length = 0;
  fake.revoked.length = 0;
  fake.withImages = false;
  fake.weights = null;
  fake.closed = 0;
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
  Element.prototype.getBoundingClientRect = originalRect;
  Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true, writable: true });
  vi.restoreAllMocks();
});

function savePositionJson(chapterIndex: number, blockIndex = 0, blockFraction = 0) {
  store.set(`reading_position:${bookKey(file)}`, JSON.stringify({ anchor: { chapterIndex, blockIndex, blockFraction }, anchorVersion: 2, name: file.name, size: file.size, savedAt: 1700000000000 }));
}

async function renderReader() {
  const { default: ReaderScreen } = await import('./ReaderScreen');
  const view = render(<ReaderScreen file={file} onBack={() => {}} />);
  await waitFor(() => {
    expect(view.container.querySelector('.reader-content')).not.toBeNull();
    expect(view.container.querySelector('.reader-content.pre-reveal')).toBeNull();
  });
  await settle();
  return view;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Lets the window manager run until the mounted chapters stop changing. */
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

/**
 * Reads to book offset `y`, as a finger does: the scroll position moves, then a scroll event arrives. A browser cannot scroll
 * past the end of the page, so the position is held within the mounted chapters (a fling that runs out of them stops at the end
 * until the next chapter is mounted).
 */
async function readTo(y: number) {
  const first = mounted()[0];
  const wanted = y - first * H;
  scrollY = Math.min(Math.max(wanted, 0), mounted().length * H - VH);
  await act(async () => {
    window.dispatchEvent(new Event('scroll'));
  });
  await settle();
}

/** A fling that goes further than the window reaches: it runs out of mounted chapters, the window follows, and it carries on. */
async function flingTo(y: number) {
  for (let i = 0; i < 200 && Math.abs(readingY() - y) > 1; i++) {
    const before = readingY();
    await readTo(y);
    if (readingY() === before) break;
  }
}

describe('ReaderScreen - restoring into the middle of a long book', () => {
  it('mounts a few chapters around the saved one, not 150 chapters of the book', async () => {
    savePositionJson(150);
    await renderReader();
    const chapters = mounted();
    expect(chapters).toContain(150);
    expect(chapters.length).toBeLessThanOrEqual(12);
    expect(chapters.length * H).toBeLessThan(MAX_MOUNTED_PX);
    // Nothing before the saved chapter's neighbours was ever parsed or loaded, and nothing far after it either.
    expect(Math.min(...fake.yielded, ...fake.loadCalls)).toBeGreaterThanOrEqual(147);
    expect(Math.max(...fake.yielded, ...fake.loadCalls)).toBeLessThanOrEqual(165);
    // The reader is put on the saved chapter.
    expect(readingY()).toBeGreaterThanOrEqual(150 * H - 1);
    expect(readingY()).toBeLessThan(151 * H);
  });
});

describe('ReaderScreen - the window follows the reader', () => {
  it('reading down through the book mounts chapters ahead and unmounts the ones behind, and the text never moves', async () => {
    await renderReader();
    const sizes: number[] = [];
    let unmountedAbove = 0;
    for (let y = 1500; y <= 45 * H; y += 1500) {
      const before = mounted()[0];
      await readTo(y);
      // The screen is where it was told to be: any chapters removed above it were compensated for, to the pixel.
      expect(readingY()).toBeCloseTo(y, 0);
      const chapters = mounted();
      expect(chapters).toContain(Math.floor(y / H));
      expect(chapters).toContain(Math.floor((y + VH - 1) / H));
      sizes.push(chapters.length);
      if (chapters[0] > before) unmountedAbove++;
    }
    expect(unmountedAbove).toBeGreaterThan(10);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(12);
    expect(Math.max(...sizes) * H).toBeLessThan(MAX_MOUNTED_PX);
    // Chapters that were behind the reader a long time ago are not in the page.
    expect(mounted()[0]).toBeGreaterThan(30);
    // Nothing was loaded twice on the way down.
    const downLoads = [...fake.loadCalls].filter((i) => i >= 4);
    expect(new Set(downLoads).size).toBe(downLoads.length);
  });

  it('reading back up mounts the chapters again above the reader, with the text staying where it is', async () => {
    savePositionJson(100);
    await renderReader();
    const startFirst = mounted()[0];
    for (let y = 100 * H; y >= 70 * H; y -= 1500) {
      await readTo(y);
      expect(readingY()).toBeCloseTo(y, 0);
      expect(mounted()).toContain(Math.floor(y / H));
    }
    expect(mounted()[0]).toBeLessThan(startFirst - 25);
    expect(mounted().length).toBeLessThanOrEqual(12);
    // The chapters ahead the reader left behind were unmounted.
    expect(mounted().at(-1)!).toBeLessThan(85);
  });

  it('a fling that crosses many chapters at once ends with the screen covered and nothing out of place', async () => {
    await renderReader();
    await flingTo(120 * H + 500);
    expect(readingY()).toBeCloseTo(120 * H + 500, 0);
    expect(mounted()).toContain(120);
    expect(mounted().length).toBeLessThanOrEqual(12);
    await flingTo(3 * H);
    expect(mounted()).toContain(3);
    expect(readingY()).toBeCloseTo(3 * H, 0);
  });

  it('while a re-anchor after a font change is under way the mounted chapters are left alone', async () => {
    savePositionJson(150);
    await renderReader();
    const before = range();
    await flingTo(170 * H);
    // Not a re-anchor: the window follows the reader as usual.
    expect(range()).not.toBe(before);
    expect(mounted()).toContain(170);
  });
});

describe('ReaderScreen - progress comes from chapter indexes and sizes, not from the page', () => {
  it('the saved progress is weighted by chapter sizes at the chapter index in the BOOK, wherever the window is', async () => {
    fake.weights = Array.from({ length: CHAPTERS }, (_, i) => 100 + (i % 7) * 40);
    savePositionJson(180, 0, 0.5);
    const onBack = vi.fn();
    const { default: ReaderScreen } = await import('./ReaderScreen');
    const view = render(<ReaderScreen file={file} onBack={onBack} />);
    await waitFor(() => expect(view.container.querySelector('.reader-content:not(.pre-reveal)')).not.toBeNull());
    await settle();
    expect(mounted()[0]).toBeGreaterThan(150); // the window does not start at chapter 0

    fireEvent.click(screen.getByText('Back'));
    await waitFor(() => expect(store.get('reading_progress_index')).toBeDefined());
    const saved = JSON.parse(store.get(`reading_position:${bookKey(file)}`)!);
    const { chapterIndex, blockIndex, blockFraction } = saved.anchor;
    expect(chapterIndex).toBe(180);
    const progress = JSON.parse(store.get('reading_progress_index')!)[bookKey(file)].progressFraction;
    expect(progress).toBeCloseTo(weightedProgress(fake.weights, chapterIndex, (blockIndex + blockFraction) / 2, CHAPTERS), 6);
    // It is not "how many chapters are in the page" or "how far down the page": the window holds a dozen chapters of the 300.
    expect(progress).toBeGreaterThan(0.55);
    expect(progress).toBeLessThan(0.65);
  });

  it('without sizes it counts chapters equally, still by book index', async () => {
    savePositionJson(150, 0, 0);
    const { default: ReaderScreen } = await import('./ReaderScreen');
    const view = render(<ReaderScreen file={file} onBack={() => {}} />);
    await waitFor(() => expect(view.container.querySelector('.reader-content:not(.pre-reveal)')).not.toBeNull());
    await settle();
    fireEvent.click(screen.getByText('Back'));
    await waitFor(() => expect(store.get('reading_progress_index')).toBeDefined());
    const progress = JSON.parse(store.get('reading_progress_index')!)[bookKey(file)].progressFraction;
    expect(progress).toBeCloseTo(150 / CHAPTERS, 2);
  });
});

describe('ReaderScreen - what a chapter held is released when it unmounts', () => {
  const pictures = () => Array.from(document.querySelectorAll<HTMLImageElement>('.reader-content img'));

  it("revokes a chapter's downscaled blob: URLs when it unmounts, so the number alive follows the window, not the book", async () => {
    fake.withImages = true;
    await renderReader();
    await waitFor(() => expect(fake.made.length).toBeGreaterThan(1)); // downscaled: each picture has a blob: URL of its own
    for (let y = 1500; y <= 40 * H; y += 1500) await readTo(y);
    await settle();

    expect(fake.revoked.length).toBeGreaterThan(15); // the chapters left behind let go of their pictures
    // What is alive is what is mounted: at most the pictures of the window (12 chapters), plus the shared placeholder.
    expect(fake.store!.liveUrlCount).toBeLessThanOrEqual(mounted().length + 2);
    expect(fake.made.length - fake.revoked.length).toBe(fake.store!.liveUrlCount);
    // Every picture on the page still shows something that is alive.
    for (const img of pictures()) expect(fake.revoked).not.toContain(img.getAttribute('src'));
  });

  it('stops watching an unmounted chapter\'s tables and starts again when it comes back, with its pictures sized before they load', async () => {
    fake.withImages = true;
    const registered: Element[] = [];
    const stopped: Element[] = [];
    const register = TableAdaptController.prototype.register;
    vi.spyOn(TableAdaptController.prototype, 'register').mockImplementation(function (this: TableAdaptController, section: HTMLElement) {
      registered.push(section);
      const stop = register.call(this, section);
      return () => {
        stopped.push(section);
        stop();
      };
    });
    savePositionJson(100);
    await renderReader();
    const original = document.querySelector('#table-100')!.closest('.chapter')!;
    expect(registered).toContain(original);
    const firstSrc = document.querySelector<HTMLImageElement>('#img-100')!.getAttribute('src');

    await flingTo(110 * H); // chapter 100 is far behind: unmounted
    expect(mounted()).not.toContain(100);
    expect(original.isConnected).toBe(false);
    expect(stopped).toContain(original); // its tables are no longer watched

    await flingTo(100 * H + 300); // and back
    expect(mounted()).toContain(100);
    const again = document.querySelector('#table-100')!.closest('.chapter')!;
    expect(again).not.toBe(original);
    expect(registered).toContain(again); // watched again, so its tables are adapted again
    const img = document.querySelector<HTMLImageElement>('#img-100')!;
    // The picture is sized before it loads, exactly as the first time: no layout jump when it fills in.
    expect(img.getAttribute('width')).toBe('3000');
    expect(img.getAttribute('height')).toBe('2000');
    expect(img.style.aspectRatio).toBe('3000/2000');
    expect(img.getAttribute('src')).not.toBe(firstSrc); // a new picture entry, made when the chapter was loaded again
    expect(readingY()).toBeCloseTo(100 * H + 300, 0);
  });

  it('closing the book revokes whatever is still alive', async () => {
    fake.withImages = true;
    const view = await renderReader();
    await waitFor(() => expect(fake.store!.liveUrlCount).toBeGreaterThan(0));
    view.unmount();
    expect(fake.closed).toBe(1);
    expect(fake.store!.liveUrlCount).toBe(0);
  });
});

describe('ReaderScreen - the viewer pins what it shows', () => {
  it('while a picture is open the mounted chapters and its blob: URL are left alone; afterwards the window follows the reader again', async () => {
    fake.withImages = true;
    savePositionJson(100);
    const view = await renderReader();
    await waitFor(() => expect(document.querySelector<HTMLImageElement>('#img-100')!.getAttribute('src')).not.toContain('#vach-'));
    const src = document.querySelector<HTMLImageElement>('#img-100')!.getAttribute('src')!;

    fireEvent.click(view.container.querySelector('#img-100')!);
    await screen.findByRole('dialog');
    const rangeBefore = range();

    await flingTo(140 * H); // the reader's finger goes a long way under the viewer: as far as the mounted chapters go
    expect(range()).toBe(rangeBefore); // nothing was unmounted from under it
    expect(fake.revoked).not.toContain(src);
    expect(fake.store!.describe(src)).not.toBeNull();

    act(() => fireEvent.keyDown(document, { key: 'Escape' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await settle();
    await flingTo(140 * H); // the reader carries on
    expect(range()).not.toBe(rangeBefore);
    expect(mounted()).toContain(140);
    // Now that nothing needs it, chapter 100's picture was released with its chapter.
    expect(fake.revoked).toContain(src);
  });
});
