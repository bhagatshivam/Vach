import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import type { LibraryFile } from '../lib/libraryFolder';

// Expand Grid through the whole reader: a table too wide for the screen is
// adapted after the chapter mounts, its Expand Grid button opens the lightbox,
// and Back / Escape / the close button close it.

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(async () => ({ value: null })), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
}));
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: async () => {} })), exitApp: vi.fn() },
}));

const WIDE_HEADERLESS = `<table><tbody><tr>${Array.from({ length: 9 }, (_, i) => `<td>cell${i}</td>`).join('')}</tr><tr>${Array.from({ length: 9 }, (_, i) => `<td>more${i}</td>`).join('')}</tr></tbody></table>`;
const WIDE_HEADED = `<table><thead><tr>${Array.from({ length: 9 }, (_, i) => `<th>Col${i}</th>`).join('')}</tr></thead><tbody><tr>${Array.from({ length: 9 }, (_, i) => `<td>v${i}</td>`).join('')}</tr></tbody></table>`;

vi.mock('../lib/epubFile', () => ({
  openEpubFile: async () => ({
    title: 'Tables',
    chapterCount: 1,
    loadChapter: async () => '',
    stream: async function* () {
      yield { type: 'title', title: 'Tables' };
      yield { type: 'total', count: 1 };
      yield { type: 'chapter', html: `<p>intro</p>${WIDE_HEADERLESS}<p>middle</p>${WIDE_HEADED}<p>end</p>` };
    },
  }),
}));

const file: LibraryFile = { name: 'tables.epub', uri: 'content://x/tables.epub', path: 'tables.epub', size: 1234 };
const originalRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), load: async () => [] }, configurable: true });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  // The column is 360px wide; a table needs 1,000px however it is styled.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const rect = (left: number, width: number) => ({ top: 0, bottom: 10, left, right: left + width, width, height: 10, x: left, y: 0, toJSON: () => ({}) });
    if (this.tagName === 'TABLE') return rect(0, 1000);
    if (this.classList.contains('chapter')) return rect(0, 360);
    return rect(0, 0);
  };
});

afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = originalRect;
  vi.restoreAllMocks();
});

async function openReader(overlayCloseRef = createRef<(() => void) | null>() as { current: (() => void) | null }) {
  const { default: ReaderScreen } = await import('./ReaderScreen');
  const view = render(<ReaderScreen file={file} onBack={() => {}} overlayCloseRef={overlayCloseRef} />);
  await waitFor(() => expect(view.container.querySelector('.vach-table-collapsed')).not.toBeNull());
  return { view, overlayCloseRef };
}

describe('ReaderScreen - wide tables and Expand Grid', () => {
  it('a too-wide headerless table becomes a placeholder; a too-wide headed table becomes cards - both offer Expand Grid', async () => {
    const { view } = await openReader();
    const tables = Array.from(view.container.querySelectorAll('table'));
    expect(tables.map((t) => t.getAttribute('data-vach-mode'))).toEqual(['collapsed', 'cards']);
    expect(view.container.querySelector('.vach-table-summary')?.textContent).toBe('Table · 2 rows × 9 columns');
    expect(screen.getAllByText('Expand Grid')).toHaveLength(2);
    // Cards got their labels.
    expect(tables[1].querySelector('tbody td')?.getAttribute('data-label')).toBe('Col0');
  });

  it('Expand Grid opens the table in the lightbox; the reader page underneath is left as it was', async () => {
    const { view } = await openReader();
    fireEvent.click(screen.getAllByText('Expand Grid')[0]);

    const dialog = await screen.findByRole('dialog', { name: 'Table' });
    const clone = dialog.querySelector('table')!;
    expect(clone.classList.contains('vach-table-grid')).toBe(true);
    expect(clone.querySelectorAll('td')).toHaveLength(18); // the whole grid, unadapted
    expect(clone.querySelector('[data-label]')).toBeNull();
    expect(view.container.querySelectorAll('.reader-content table')).toHaveLength(2); // the originals stay in place
    expect(view.container.querySelector('.reader-content')?.contains(dialog)).toBe(false);
  });

  it('tapping Expand Grid does not toggle the header (it is not a tap on the page)', async () => {
    const { view } = await openReader();
    const header = view.container.querySelector('.reader-header')!;
    expect(header.classList.contains('hidden')).toBe(false);
    fireEvent.click(screen.getAllByText('Expand Grid')[0]);
    expect(header.classList.contains('hidden')).toBe(false);
  });

  it('the close button, Escape and hardware Back each close it', async () => {
    const { overlayCloseRef } = await openReader();

    fireEvent.click(screen.getAllByText('Expand Grid')[0]);
    fireEvent.click(await screen.findByLabelText('Close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getAllByText('Expand Grid')[0]);
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Back is whatever the app's single back handler finds in the shared ref.
    fireEvent.click(screen.getAllByText('Expand Grid')[0]);
    await screen.findByRole('dialog');
    expect(overlayCloseRef.current).toBeTypeOf('function');
    act(() => overlayCloseRef.current!());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(overlayCloseRef.current).toBeNull();
  });
});
