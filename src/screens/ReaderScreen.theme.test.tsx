import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { LibraryFile } from '../lib/libraryFolder';

// The reader keeps the page (and, natively, the system bars) the colour of its theme.

const prefs = vi.hoisted(() => ({ settings: null as string | null }));
const native = vi.hoisted(() => ({ apply: vi.fn(async () => {}) }));

vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ apply: native.apply }) }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: key === 'reader_settings' ? prefs.settings : null })),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  },
}));
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: async () => {} })), exitApp: vi.fn() },
}));
vi.mock('../lib/epubFile', async () => {
  const { ImageStore } = await import('../lib/imageProcessor');
  return {
  openEpubFile: async () => ({
    images: new ImageStore(),
    close() {},
    toc: async () => [],
    chapterWeights: null,
    title: 'Book',
    chapterCount: 1,
    loadChapter: async () => '',
    stream: async function* () {
      yield { type: 'title', title: 'Book' };
      yield { type: 'total', count: 1 };
      yield { type: 'chapter', html: '<p>hello</p>' };
    },
  }),
  };
});

import { resetSystemThemeForTests } from '../lib/systemTheme';

const file: LibraryFile = { name: 'b.epub', uri: 'content://x/b.epub', path: 'b.epub', size: 10 };
const paint = (color: string) => {
  const probe = document.createElement('i');
  probe.style.backgroundColor = color;
  return probe.style.backgroundColor;
};

beforeEach(() => {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), load: async () => [] }, configurable: true });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  resetSystemThemeForTests();
  native.apply.mockClear();
  document.documentElement.removeAttribute('style');
  document.body.removeAttribute('style');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function open(settings: object | null) {
  prefs.settings = settings ? JSON.stringify(settings) : null;
  const { default: ReaderScreen } = await import('./ReaderScreen');
  const view = render(<ReaderScreen file={file} onBack={() => {}} />);
  await waitFor(() => expect(view.container.querySelector('.reader-content')).not.toBeNull());
  return view;
}

describe('ReaderScreen - page and system bars follow the theme', () => {
  it.each([
    ['sepia', { theme: 'sepia' }, '#f4ecd8', true],
    ['beige', { theme: 'beige' }, '#ddd7c8', true],
    ['night', { theme: 'night' }, '#121212', false],
    ['custom', { theme: 'custom', customBackground: '#102030', customText: '#f0f0f0' }, '#102030', false],
  ])('%s', async (_name, settings, background, darkIcons) => {
    const view = await open(settings);
    await waitFor(() => expect(document.documentElement.style.backgroundColor).toBe(paint(background)));
    expect(document.body.style.backgroundColor).toBe(paint(background));
    expect(view.container.querySelector<HTMLElement>('.reader')!.style.background).toBe(paint(background));
    expect(native.apply).toHaveBeenLastCalledWith({ background, darkIcons });
  });

  it('the reader fills the screen: .reader is the themed box, .reader-content is the narrow column inside it', async () => {
    const view = await open({ theme: 'night' });
    const reader = view.container.querySelector('.reader')!;
    expect(reader.querySelector(':scope > .reader-content')).not.toBeNull();
    expect(reader.parentElement).toBe(view.container);
  });
});
