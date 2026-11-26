import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import type { LibraryFile } from '../lib/libraryFolder';
import type { DocxConversion } from '../lib/docxTypes';

// A .docx through the whole reader: routed to the Word opener (never the EPUB parser), shown like an EPUB (Contents,
// positions), its errors in plain words, internal links that jump, and the PR #12 rule for far jumps.

const state = vi.hoisted(() => ({
  prefs: new Map<string, string>(),
  html: '' as string,
  title: null as string | null,
  openDocxCalls: [] as string[],
  openEpubCalls: 0,
  streamStarts: [] as number[],
  failWith: null as null | Error,
}));

vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ apply: async () => {} }) }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: state.prefs.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => void state.prefs.set(key, value)),
    remove: vi.fn(async ({ key }: { key: string }) => void state.prefs.delete(key)),
  },
}));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async () => ({ remove: async () => {} })), exitApp: vi.fn() } }));
vi.mock('../lib/epubFile', () => ({
  openEpubFile: async () => {
    state.openEpubCalls++;
    throw new Error('a .docx must never reach the EPUB parser');
  },
}));
vi.mock('../lib/docxFile', async () => {
  const { openDocx } = await import('../lib/docx');
  return {
    openDocxFile: async (uri: string, fallbackTitle: string) => {
      state.openDocxCalls.push(`${uri}|${fallbackTitle}`);
      if (state.failWith) throw state.failWith;
      const conversion: DocxConversion = { html: state.html, images: [], title: state.title, warnings: [] };
      const book = await openDocx(new ArrayBuffer(8), fallbackTitle, { convert: async () => conversion });
      const stream = book.stream.bind(book);
      book.stream = async function* (startIndex?: number) {
        state.streamStarts.push(startIndex ?? 0);
        yield* stream(startIndex);
      };
      return book;
    },
  };
});
vi.mock('../lib/fileBridge', () => ({ FileTooLargeError: class extends Error {}, createFileSource: async () => ({ size: 1, read: async () => new Uint8Array(1) }) }));

import { DocxError } from '../lib/docxError';
import { MAX_DIRECT_JUMP_OFFSET_PX } from '../lib/chapterWindow';

const file: LibraryFile = { name: 'Quarterly_Report.docx', uri: 'content://x/Quarterly_Report.docx', path: 'Quarterly_Report.docx', size: 4321 };

let scrollY = 0;
let chapterHeight = 100;
const scrollTo = vi.fn();
const originalRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  state.prefs.clear();
  state.html = '';
  state.title = null;
  state.openDocxCalls = [];
  state.openEpubCalls = 0;
  state.streamStarts = [];
  state.failWith = null;
  scrollY = 0;
  chapterHeight = 100;
  scrollTo.mockReset();
  scrollTo.mockImplementation((arg: ScrollToOptions) => {
    if (typeof arg === 'object' && typeof arg.top === 'number') scrollY = arg.top;
  });
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), load: async () => [] }, configurable: true });
  Object.defineProperty(window, 'scrollY', { get: () => scrollY, configurable: true });
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  window.scrollBy = vi.fn((arg: ScrollToOptions) => {
    if (typeof arg === 'object' && typeof arg.top === 'number') scrollY += arg.top;
  }) as unknown as typeof window.scrollBy;
  // Chapters stack from the first one mounted; an anchor sits 40px into its chapter.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 360, width: 360, height, x: 0, y: top, toJSON: () => ({}) });
    const chapter = this.classList.contains('chapter') ? this : this.closest('.chapter');
    if (chapter?.parentElement) {
      const index = Array.from(chapter.parentElement.querySelectorAll(':scope > .chapter')).indexOf(chapter);
      const top = index * chapterHeight - scrollY + (this.hasAttribute('data-vach-anchor') ? 40 : 0);
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

async function openReader(options: { savedChapter?: number; fileOverride?: LibraryFile } = {}) {
  const overlayCloseRef = createRef<(() => void) | null>() as { current: (() => void) | null };
  const { default: ReaderScreen } = await import('./ReaderScreen');
  const view = render(<ReaderScreen file={options.fileOverride ?? file} onBack={() => {}} overlayCloseRef={overlayCloseRef} />);
  await waitFor(() => expect(view.container.querySelector('.reader-content:not(.pre-reveal) .chapter, .error')).not.toBeNull());
  return { view, overlayCloseRef };
}

const words = (n: number, label: string) => Array.from({ length: n }, (_, i) => `${label}${i}`).join(' ');
const longDocument = (totalWords: number) => Array.from({ length: totalWords / 100 }, (_, i) => `<p>${words(100, `p${i}_`)}</p>`).join('');

describe('ReaderScreen - a .docx', () => {
  it('is opened by the Word opener with its cleaned file name as the fallback title - never by the EPUB parser', async () => {
    state.html = `<h1>Summary</h1><p>${words(40, 'a')}</p><h1>Details</h1><p>${words(40, 'b')}</p>`;
    const { view } = await openReader();
    expect(state.openDocxCalls).toEqual(['content://x/Quarterly_Report.docx|Quarterly Report']);
    expect(state.openEpubCalls).toBe(0);
    expect(view.container.querySelector('.reader-title')?.textContent).toBe('Quarterly Report');
    expect(view.container.querySelectorAll('.reader-content .chapter')).toHaveLength(2);
  });

  it('prefers the document’s own title (core.xml) over the file name', async () => {
    state.html = `<h1>A</h1><p>x</p><h1>B</h1><p>y</p>`;
    state.title = 'Annual Review';
    const { view } = await openReader();
    expect(view.container.querySelector('.reader-title')?.textContent).toBe('Annual Review');
  });

  it('the extension is matched in any case', async () => {
    state.html = '<h1>A</h1><p>x</p>';
    await openReader({ fileOverride: { ...file, name: 'LOUD.DOCX', uri: 'content://x/LOUD.DOCX' } });
    expect(state.openEpubCalls).toBe(0);
    expect(state.openDocxCalls).toHaveLength(1);
  });

  it('headings become Contents entries; a heading-less document lists "Section N"', async () => {
    state.html = `<h1>Summary</h1><p>${words(40, 'a')}</p><h2>Details</h2><p>${words(40, 'b')}</p>`;
    await openReader();
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    expect(await screen.findByRole('button', { name: 'Summary' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy();
    cleanup();

    state.html = longDocument(9000);
    await openReader();
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    expect(await screen.findByRole('button', { name: 'Section 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Section 2' })).toBeTruthy();
  });
});

describe('ReaderScreen - a .docx that cannot be opened', () => {
  it.each([
    ['password-protected', /password-protected/],
    ['not-docx', /isn't a Word/],
    ['corrupt', /damaged/],
    ['unreadable', /could not be read/],
  ] as const)('%s: a clear message, no "Error:" prefix, no crash', async (code, pattern) => {
    state.failWith = new DocxError(code);
    const { view } = await openReader();
    const message = view.container.querySelector('.error')?.textContent ?? '';
    expect(message).toMatch(pattern);
    expect(message).not.toMatch(/^Error|DocxError/);
    expect(screen.getByText('Failed to open book.')).toBeTruthy();
    expect(view.container.querySelector('.reader-content')).toBeNull();
  });

  it('an empty document shows an empty-state message, not an error', async () => {
    state.html = '<p></p>';
    const { view } = await openReader();
    expect(view.container.textContent).toContain('This document is empty.');
    expect(view.container.querySelector('.error')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Contents' })).toBeNull();
  });

  it('a one-section document opens and has no Contents button', async () => {
    state.html = `<p>${words(50, 'solo')}</p>`;
    const { view } = await openReader();
    expect(view.container.querySelectorAll('.reader-content .chapter')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Contents' })).toBeNull();
  });
});

describe('ReaderScreen - internal links in a .docx', () => {
  const doc = `<h1>One</h1><p>text<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup> more ${words(30, 'k')}</p><h1>Two</h1><p>${words(30, 'm')}</p><h1>Three</h1><ol><li id="footnote-1"><p>the note <a href="#footnote-ref-1">back</a></p></li></ol>`;

  it('a footnote number jumps to the note in another chapter, and the note’s arrow jumps back', async () => {
    state.html = doc;
    const { view } = await openReader();
    await waitFor(() => expect(view.container.querySelectorAll('.reader-content .chapter')).toHaveLength(3));
    const ref = view.container.querySelector<HTMLElement>('[data-vach-link="footnote-1"]');
    expect(ref?.textContent).toBe('[1]');
    scrollTo.mockClear();

    fireEvent.click(ref!);
    // Chapter index 2, and the note sits 40px into it: 2 x 100 + 40.
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 240 })));
    expect(document.querySelector('.reader-header')!.classList.contains('hidden')).toBe(true);

    scrollTo.mockClear();
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-vach-link="footnote-ref-1"]')!);
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 40 })));
  });

  it('tapping a link does not also toggle the header like an ordinary tap on the page', async () => {
    state.html = doc;
    const { view } = await openReader();
    await waitFor(() => expect(view.container.querySelectorAll('.reader-content .chapter')).toHaveLength(3));
    const header = view.container.querySelector('.reader-header')!;
    expect(header.classList.contains('hidden')).toBe(false);
    fireEvent.click(view.container.querySelector('[data-vach-link="footnote-1"]')!);
    await waitFor(() => expect(header.classList.contains('hidden')).toBe(true)); // hidden by the jump itself, not toggled back
  });

  it('a link to an id the document does not have is plain text, not a dead link', async () => {
    state.html = `<h1>One</h1><p>see <a href="#missing">here</a> and <a href="https://example.com">there</a></p><h1>Two</h1><p>x</p>`;
    const { view } = await openReader();
    expect(view.container.querySelector('[data-vach-link]')).toBeNull();
    expect(view.container.querySelector('.reader-content a')).toBeNull();
    expect(view.container.textContent).toContain('see here and there');
  });

  it('an ordinary tap (not on a link) still toggles the header', async () => {
    state.html = doc;
    const { view } = await openReader();
    const header = view.container.querySelector('.reader-header')!;
    fireEvent.click(view.container.querySelector('.reader-content .chapter p')!);
    expect(header.classList.contains('hidden')).toBe(true);
  });
});

describe('ReaderScreen - jumping to the last section of a 100,000-word .docx (the PR #12 rule)', () => {
  const sectionCount = () => document.querySelectorAll('.reader-content .chapter').length;
  // The document's sections, as the Contents lists them: only a window of them is mounted at any time.
  const contentsEntries = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    return Array.from(document.querySelectorAll('.toc-item')).map((b) => b.textContent ?? '');
  };

  it('the document is about 36 sections and the Contents lists them all, though only a window of them is mounted', async () => {
    state.html = longDocument(100_000);
    chapterHeight = 10_000; // each section is far taller than the screen: the window is a few of them
    await openReader();
    const entries = await contentsEntries();
    expect(entries.length).toBeGreaterThanOrEqual(35);
    expect(entries.length).toBeLessThanOrEqual(37);
    expect(entries.at(-1)).toBe(`Section ${entries.length}`);
    await waitFor(() => expect(sectionCount()).toBeLessThan(8));
  });

  it('a section in the window is just scrolled to', async () => {
    state.html = longDocument(100_000);
    chapterHeight = 3_000; // the first four sections (12,000px) are all within the window of a 768px screen
    await openReader();
    await waitFor(() => expect(sectionCount()).toBeGreaterThanOrEqual(4));
    scrollTo.mockClear();
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Section 3' }));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 2 * 3_000 })));
    expect(state.openDocxCalls).toHaveLength(1);
  });

  it('a section outside the window reopens the window at it instead of scrolling there', async () => {
    state.html = longDocument(100_000);
    chapterHeight = 100_000; // the last section would be ~3.5M px down
    await openReader();
    const last = (await contentsEntries()).length;
    expect((last - 1) * chapterHeight).toBeGreaterThan(MAX_DIRECT_JUMP_OFFSET_PX);
    scrollTo.mockClear();

    fireEvent.click(await screen.findByRole('button', { name: `Section ${last}` }));

    // The window is reopened at the last section (and the one before it), through the same opener.
    await waitFor(() => expect(state.streamStarts.at(-1)).toBe(last - 2));
    expect(state.openDocxCalls).toHaveLength(2);
    expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ top: (last - 1) * chapterHeight }));
    // ...and the last section is what is mounted and showing, in a short window.
    await waitFor(() => expect(document.querySelector('.reader-content:not(.pre-reveal)')).not.toBeNull());
    expect(sectionCount()).toBeLessThanOrEqual(4);
    expect(document.querySelector('.reader-content')?.textContent).toContain(`p${(1000 - 1)}_0`);
    await waitFor(() => {
      const saved = [...state.prefs.entries()].find(([k]) => k.startsWith('reading_position:'));
      expect(saved && JSON.parse(saved[1]).anchor.chapterIndex).toBe(last - 1);
    }, { timeout: 4000 });
  });

  it('the same goes for a heading-based document: a jump to a deep last heading reopens the window', async () => {
    state.html = Array.from({ length: 40 }, (_, i) => `<h1>Chapter ${i + 1}</h1><p>${words(60, `c${i}_`)}</p>`).join('');
    chapterHeight = 100_000;
    await openReader();
    await waitFor(() => expect(sectionCount()).toBeLessThan(10));
    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Chapter 40' }));
    await waitFor(() => expect(state.streamStarts.at(-1)).toBe(38));
  });
});

describe('ReaderScreen - a saved position in a .docx', () => {
  it('reopens in the saved section, mounting from the one before it, not from the start', async () => {
    state.html = longDocument(30_000); // ~11 sections
    const { savePosition } = await import('../lib/readingPosition');
    await savePosition(file, { chapterIndex: 6, blockIndex: 0, blockFraction: 0 }, 0.5);
    const { view } = await openReader();
    expect(state.streamStarts).toEqual([5]);
    expect(view.container.querySelector('.restore-overlay')).toBeNull();
    expect(view.container.querySelector('.reader-content:not(.pre-reveal)')).not.toBeNull();
  });
});
