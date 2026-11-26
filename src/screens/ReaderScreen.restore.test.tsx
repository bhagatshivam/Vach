import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LibraryFile } from '../lib/libraryFolder';
import { bookKey } from '../lib/readingPosition';
import { chapterRenderProbe } from '../lib/chapterRenderProbe';

// ReaderScreen against a fake lazily-opened EPUB (epubFile.ts mocked), with
// Capacitor's Preferences backed by a Map. jsdom has no layout, so
// getBoundingClientRect is stubbed to a simple model: each chapter section is
// 100px tall, stacked in DOM order, with the viewport top 250px into the
// mounted content.

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

const CHAPTERS = 12;

const book = {
  streamStarts: [] as number[],
  loadCalls: [] as number[],
  // Number of chapters the stream has yielded, to prove nothing before the start index was parsed.
  yielded: [] as number[],
};

vi.mock('../lib/epubFile', async () => {
  const { ImageStore } = await import('../lib/imageProcessor');
  return {
  openEpubFile: async () => ({
    images: new ImageStore(),
    close() {},
    toc: async () => [],
    chapterWeights: null,
    title: 'Fixture',
    chapterCount: CHAPTERS,
    loadChapter: async (index: number) => {
      book.loadCalls.push(index);
      return `<p>CH_${index}</p>`;
    },
    stream: async function* (startIndex = 0) {
      book.streamStarts.push(startIndex);
      yield { type: 'title', title: 'Fixture' };
      yield { type: 'total', count: CHAPTERS };
      for (let i = startIndex; i < CHAPTERS; i++) {
        book.yielded.push(i);
        yield { type: 'chapter', html: `<p>CH_${i}</p>` };
      }
    },
  }),
  };
});

const file: LibraryFile = { name: 'book.epub', uri: 'content://x/book.epub', path: 'book.epub', size: 123456 };

function savePositionJson(chapterIndex: number) {
  // The exact shape the previous release wrote: no version field.
  store.set(
    `reading_position:${bookKey(file)}`,
    JSON.stringify({ anchor: { chapterIndex, blockIndex: 0, blockFraction: 0 }, name: file.name, size: file.size, savedAt: 1700000000000 }),
  );
}

let scrollTo: ReturnType<typeof vi.spyOn>;
let scrollBy: ReturnType<typeof vi.spyOn>;
const originalRect = Element.prototype.getBoundingClientRect;

function setScrollY(value: number) {
  Object.defineProperty(window, 'scrollY', { value, configurable: true, writable: true });
}

// The stubbed layout below puts the reader 250px into the mounted chapters whatever the scroll offset, so "the reader is far
// from the top" is modelled by a screen too short to want earlier chapters: the window loads another chapter when fewer
// than 5 screens of mounted content remain beyond the screen, and 5 screens of 40px is less than the 250px above.
function setViewportHeight(value: number) {
  Object.defineProperty(window, 'innerHeight', { value, configurable: true, writable: true });
}
const originalInnerHeight = window.innerHeight;

function stubLayout(viewportTopOffset = 250) {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const section = this.classList.contains('chapter') ? this : this.closest('.chapter');
    const rect = (top: number) => ({ top, bottom: top + 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: top, toJSON: () => ({}) });
    if (!section || !section.parentElement) return rect(0);
    const index = Array.from(section.parentElement.children).filter((c) => c.classList.contains('chapter')).indexOf(section);
    return rect(index * 100 - viewportTopOffset);
  };
}

beforeEach(() => {
  store.clear();
  book.streamStarts.length = 0;
  book.loadCalls.length = 0;
  book.yielded.length = 0;
  setScrollY(0);
  setViewportHeight(originalInnerHeight);
  Object.defineProperty(document, 'fonts', {
    value: { ready: Promise.resolve(), load: async () => [] },
    configurable: true,
  });
  scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  stubLayout();
});

afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = originalRect;
  chapterRenderProbe.onRender = null;
  vi.restoreAllMocks();
});

async function renderReader(onBack = () => {}) {
  const { default: ReaderScreen } = await import('./ReaderScreen');
  return render(<ReaderScreen file={file} onBack={onBack} />);
}

// The content element only exists once the first chapters arrive, so "not pre-reveal" alone is vacuously true before that.
const waitForReveal = (container: HTMLElement) =>
  waitFor(() => {
    expect(container.querySelector('.reader-content')).not.toBeNull();
    expect(container.querySelector('.reader-content.pre-reveal')).toBeNull();
  });

const mountedChapters = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.reader-content > section.chapter')).map((el) => el.textContent);

describe('ReaderScreen - restoring straight to a saved chapter', () => {
  it('opens an EPUB at its saved chapter without parsing the chapters before it', async () => {
    savePositionJson(8); // legacy-format position, chapter 8 of 12
    setViewportHeight(40); // far from the top: no earlier chapters are loaded yet
    const { container } = await renderReader();

    await waitForReveal(container);
    await waitFor(() => expect(container.querySelector('.loading-more')).toBeNull()); // the window reaches the last chapter

    expect(book.streamStarts).toEqual([7]); // chapter 8 minus one chapter of context
    // The first chapters of the window come from the stream (the saved chapter plus a few after it) and the rest are
    // loaded as the reader nears them: chapters 0-6 were never parsed.
    expect(book.yielded).toEqual([7, 8, 9, 10]);
    expect(book.loadCalls).toEqual([11]);
    expect(mountedChapters(container)).toEqual(['CH_7', 'CH_8', 'CH_9', 'CH_10', 'CH_11']);
    expect(scrollTo).toHaveBeenCalled(); // jumped to the saved spot
  });

  it('shows "Chapter X of Y" in book terms while restoring, not DOM order', async () => {
    savePositionJson(8);
    setScrollY(5000);
    // Hold the restore at the font wait so the overlay stays up.
    Object.defineProperty(document, 'fonts', { value: { ready: new Promise(() => {}), load: async () => [] }, configurable: true });
    const { container } = await renderReader();

    await screen.findByText('Restoring your place…');
    await waitFor(() => expect(container.querySelector('.restore-progress')?.textContent).toBe('Chapter 9 of 12'));
  });

  it('then loads earlier chapters one by one as the reader is near the top, keeping the view in place', async () => {
    savePositionJson(8);
    setScrollY(0); // within two viewports of the top: earlier chapters should load
    const { container } = await renderReader();

    // (The chapters after the window are loaded too, as the reader nears them; they are not what is checked here.)
    const earlier = () => book.loadCalls.filter((index) => index < 7);
    await waitFor(() => expect(earlier()).toEqual([6, 5, 4, 3, 2, 1, 0]));
    await waitFor(() => expect(mountedChapters(container)).toHaveLength(CHAPTERS));
    expect(mountedChapters(container)).toEqual(Array.from({ length: CHAPTERS }, (_, i) => `CH_${i}`));

    // Every prepend pushed the chapter on screen down by one 100px section; each was compensated.
    expect(scrollBy).toHaveBeenCalledTimes(7);
    for (const call of scrollBy.mock.calls) {
      expect(call[0]).toMatchObject({ top: 100, left: 0, behavior: 'instant' });
    }
  });

  it('does not scroll at all when the browser already kept the view in place', async () => {
    savePositionJson(8);
    setScrollY(0);
    // Model a browser whose own scroll anchoring already absorbed the insert:
    // the chapter on screen does not move, so there is nothing to compensate.
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const rect = (top: number) => ({ top, bottom: top + 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: top, toJSON: () => ({}) });
      const section = this.classList.contains('chapter') ? this : this.closest('.chapter');
      if (!section) return rect(0);
      const text = section.textContent ?? '';
      return rect((Number(text.replace('CH_', '')) - 9) * 100 - 50);
    };
    await renderReader();
    await waitFor(() => expect(book.loadCalls.filter((index) => index < 7)).toEqual([6, 5, 4, 3, 2, 1, 0]));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('a stale saved chapter past the end opens at the last chapters instead of hanging', async () => {
    savePositionJson(99);
    setViewportHeight(40);
    const { container } = await renderReader();
    await waitForReveal(container);
    expect(book.streamStarts).toEqual([10]);
    expect(mountedChapters(container)).toEqual(['CH_10', 'CH_11']);
  });

  it('with no saved position it starts at chapter 0 and loads nothing earlier', async () => {
    const { container } = await renderReader();
    await waitFor(() => expect(mountedChapters(container)).toHaveLength(CHAPTERS));
    expect(book.streamStarts).toEqual([0]);
    // Chapters 0-3 come from the stream and the rest are loaded one after the other as the reader nears them; nothing is
    // loaded before chapter 0, so nothing has to be compensated for.
    expect(book.loadCalls).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('"Start from beginning" on a book opened partway reopens it from chapter 0', async () => {
    savePositionJson(8);
    setScrollY(5000);
    Object.defineProperty(document, 'fonts', { value: { ready: new Promise(() => {}), load: async () => [] }, configurable: true });
    const { container } = await renderReader();

    fireEvent.click(await screen.findByText('Start from beginning'));

    await waitFor(() => expect(book.streamStarts).toEqual([7, 0]));
    await waitFor(() => expect(mountedChapters(container)).toHaveLength(CHAPTERS));
    expect(mountedChapters(container)[0]).toBe('CH_0');
    expect(container.querySelector('.reader-content.pre-reveal')).toBeNull();
  });
});

describe('ReaderScreen - saved positions use chapter indexes, not DOM order', () => {
  it('saves the position as a book chapter index and derives progress from it', async () => {
    savePositionJson(8);
    setViewportHeight(40); // keep the window at chapters 7..11
    const onBack = vi.fn();
    const { container } = await renderReader(onBack);
    await waitForReveal(container);
    await waitFor(() => expect(container.querySelector('.loading-more')).toBeNull());

    fireEvent.click(screen.getByText('Back')); // flushes the current position

    // With the stubbed layout the viewport top (reference line y=0) is inside the
    // 3rd mounted chapter, half way down it: mounted chapters 7..11 -> book chapter 9.
    await waitFor(() => expect(store.get(`reading_position:${bookKey(file)}`)).toContain('"chapterIndex":9'), );
    const saved = JSON.parse(store.get(`reading_position:${bookKey(file)}`)!);
    expect(saved.anchor).toEqual({ chapterIndex: 9, blockIndex: 0, blockFraction: 0.5 });
    expect(onBack).toHaveBeenCalled();

    const index = JSON.parse(store.get('reading_progress_index')!);
    expect(index[bookKey(file)].progressFraction).toBeCloseTo((9 + 0.5) / CHAPTERS, 5);
  });
});

describe('ReaderScreen - rendering cost while a book streams in', () => {
  it('renders every chapter exactly once while 12 chapters stream in (no re-render per append)', async () => {
    const counts = new Map<number, number>();
    chapterRenderProbe.onRender = (i) => counts.set(i, (counts.get(i) ?? 0) + 1);
    const { container } = await renderReader();
    await waitFor(() => expect(mountedChapters(container)).toHaveLength(CHAPTERS));
    await waitFor(() => expect(container.querySelector('.loading-more')).toBeNull());

    expect([...counts.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: CHAPTERS }, (_, i) => i));
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
  });
});
