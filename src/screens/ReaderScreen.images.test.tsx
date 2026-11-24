import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import type { LibraryFile } from '../lib/libraryFolder';

// Tapping a picture in the book opens it in the lightbox (instead of toggling the header);
// decoration, inline images and strangers do not; Back closes it; closing the book frees every blob.

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(async () => ({ value: null })), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
}));
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: async () => {} })), exitApp: vi.fn() },
}));

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function pngBytes(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: number[]) => [...be32(data.length), ...type.split('').map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]), ...chunk('IDAT', [0, 0, 0, 0])]);
}

const hoisted = vi.hoisted(() => ({ store: null as null | import('../lib/imageProcessor').ImageStore, closed: 0 }));

vi.mock('../lib/epubFile', async () => {
  const { ImageStore } = await import('../lib/imageProcessor');
  return {
    openEpubFile: async () => {
      const store = new ImageStore();
      hoisted.store = store;
      const reg = (path: string, w: number, h: number) => {
        const bytes = pngBytes(w, h);
        return store.register(path, bytes, 'image/png', { read: async () => bytes }).url;
      };
      const photo = reg('photo.png', 800, 600);
      const icon = reg('icon.png', 32, 32);
      const inline = reg('inline.png', 400, 400);
      return {
        images: store,
        close() {
          hoisted.closed++;
          store.revokeAll();
        },
        title: 'Pictures',
        chapterCount: 1,
        loadChapter: async () => '',
        stream: async function* () {
          yield { type: 'title', title: 'Pictures' };
          yield { type: 'total', count: 1 };
          yield {
            type: 'chapter',
            html: `<p>intro</p><img id="photo" alt="A photo" src="${photo}"><img id="icon" alt="icon" src="${icon}"><p>text <img id="inline" alt="inline" style="display:inline-block" src="${inline}"> more</p><img id="stranger" alt="x" src="blob:http://localhost/not-ours">`,
          };
        },
      };
    },
  };
});

const file: LibraryFile = { name: 'pics.epub', uri: 'content://x/pics.epub', path: 'pics.epub', size: 1234 };

beforeEach(() => {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), load: async () => [] }, configurable: true });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  hoisted.closed = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openReader() {
  const overlayCloseRef = createRef<(() => void) | null>() as { current: (() => void) | null };
  const { default: ReaderScreen } = await import('./ReaderScreen');
  const view = render(<ReaderScreen file={file} onBack={() => {}} overlayCloseRef={overlayCloseRef} />);
  await waitFor(() => expect(view.container.querySelector('#photo')).not.toBeNull());
  return { view, overlayCloseRef };
}

describe('ReaderScreen - tapping a picture', () => {
  it('opens the picture in the lightbox and leaves the header alone', async () => {
    const { view } = await openReader();
    const header = view.container.querySelector('.reader-header')!;
    expect(header.classList.contains('hidden')).toBe(false);

    fireEvent.click(view.container.querySelector('#photo')!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(header.classList.contains('hidden')).toBe(false);
    // The page underneath still has its own image.
    expect(view.container.querySelector('.reader-content #photo')).not.toBeNull();
  });

  it('a decorative icon, an image inside a line of text and one that is not the book\'s own are just taps on the page', async () => {
    const { view } = await openReader();
    const header = view.container.querySelector('.reader-header')!;
    for (const id of ['icon', 'inline', 'stranger']) {
      const before = header.classList.contains('hidden');
      fireEvent.click(view.container.querySelector(`#${id}`)!);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(header.classList.contains('hidden')).toBe(!before); // toggled like any page tap
    }
  });

  it('hardware Back closes the lightbox, and the Back hook is cleared afterwards', async () => {
    const { view, overlayCloseRef } = await openReader();
    fireEvent.click(view.container.querySelector('#photo')!);
    await screen.findByRole('dialog');
    expect(overlayCloseRef.current).toBeTypeOf('function');
    act(() => overlayCloseRef.current!());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(overlayCloseRef.current).toBeNull();
  });

  it('closing the book revokes every blob URL it made', async () => {
    const { view } = await openReader();
    expect(hoisted.store!.liveUrlCount).toBeGreaterThan(0);
    view.unmount();
    expect(hoisted.closed).toBe(1);
    expect(hoisted.store!.liveUrlCount).toBe(0);
  });
});
