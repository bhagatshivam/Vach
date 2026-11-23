import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';

const prefs = vi.hoisted(() => ({ settings: null as string | null }));

vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ apply: async () => {} }) }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: key === 'reader_settings' ? prefs.settings : null })),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  },
}));
vi.mock('../lib/libraryFolder', () => ({
  scanAllSources: vi.fn(async () => ({ sources: [], files: [], failedSources: [] })),
  addFolderSource: vi.fn(async () => {}),
  addFileSources: vi.fn(async () => {}),
  removeSource: vi.fn(async () => {}),
}));

import * as library from '../lib/libraryFolder';
import { resetSystemThemeForTests } from '../lib/systemTheme';
import LibraryScreen from './LibraryScreen';

const scan = vi.mocked(library.scanAllSources);

async function renderLibrary() {
  const view = render(<LibraryScreen onOpenBook={() => {}} sheetCloseRef={createRef<(() => void) | null>() as { current: (() => void) | null }} />);
  await screen.findByText('Your library is empty');
  return view;
}

beforeEach(() => {
  prefs.settings = null;
  resetSystemThemeForTests();
  document.documentElement.removeAttribute('style');
  document.body.removeAttribute('style');
  vi.mocked(library.addFolderSource).mockClear();
  vi.mocked(library.addFileSources).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LibraryScreen - empty state', () => {
  it('offers both "+ Add folder" and "+ Add files", styled the same', async () => {
    await renderLibrary();
    const folder = screen.getByRole('button', { name: '+ Add folder' });
    const files = screen.getByRole('button', { name: '+ Add files' });
    expect(folder.className).toBe(files.className);
    expect(folder.parentElement).toBe(files.parentElement);
  });

  it('each button calls its own picker, and the library is rescanned afterwards', async () => {
    await renderLibrary();
    scan.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '+ Add files' }));
    await waitFor(() => expect(library.addFileSources).toHaveBeenCalledTimes(1));
    expect(library.addFolderSource).not.toHaveBeenCalled();
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '+ Add folder' }));
    await waitFor(() => expect(library.addFolderSource).toHaveBeenCalledTimes(1));
    expect(library.addFileSources).toHaveBeenCalledTimes(1);
  });

  it('backing out of the picker is not shown as an error; a real failure is', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderLibrary();

    vi.mocked(library.addFileSources).mockRejectedValueOnce(new Error('File selection was cancelled'));
    fireEvent.click(screen.getByRole('button', { name: '+ Add files' }));
    await waitFor(() => expect(library.addFileSources).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector('.error')).toBeNull();

    vi.mocked(library.addFileSources).mockRejectedValueOnce(new Error('No app available on this device to pick files'));
    fireEvent.click(screen.getByRole('button', { name: '+ Add files' }));
    await waitFor(() => expect(document.querySelector('.error')?.textContent).toContain('No app available'));
  });
});

describe('LibraryScreen - adding when the library is not empty', () => {
  it('a visible "+ Add" button next to the gear opens the Sources sheet, which has Add folder and Add files', async () => {
    scan.mockResolvedValue({
      sources: [{ source: { type: 'file', uri: 'content://x/a.epub' }, displayName: 'a.epub' }],
      files: [{ name: 'a.epub', uri: 'content://x/a.epub', path: 'a.epub', size: 10 }],
      failedSources: [],
    });
    render(<LibraryScreen onOpenBook={() => {}} sheetCloseRef={createRef<(() => void) | null>() as { current: (() => void) | null }} />);
    await screen.findByText('1 book');
    expect(screen.queryByText('Your library is empty')).toBeNull();

    const add = screen.getByRole('button', { name: 'Add books' });
    expect(add.textContent).toContain('Add');
    fireEvent.click(add);
    expect(await screen.findByRole('button', { name: 'Add files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add folder' })).toBeTruthy();
    // The gear is still there under its old name.
    expect(screen.getByLabelText('Sources and settings')).toBeTruthy();
    scan.mockResolvedValue({ sources: [], files: [], failedSources: [] });
  });
});

describe('LibraryScreen - the page behind the screen follows the theme', () => {
  const paint = (color: string) => {
    const probe = document.createElement('i');
    probe.style.backgroundColor = color;
    return probe.style.backgroundColor;
  };

  it('night: <html> and <body> turn the night colour once the saved theme is known', async () => {
    prefs.settings = JSON.stringify({ theme: 'night' });
    await renderLibrary();
    await waitFor(() => expect(document.documentElement.style.backgroundColor).toBe(paint('#121212')));
    expect(document.body.style.backgroundColor).toBe(paint('#121212'));
    expect(document.querySelector<HTMLElement>('.library')!.style.background).toBe(paint('#121212'));
  });

  it('a custom colour is used as it is', async () => {
    prefs.settings = JSON.stringify({ theme: 'custom', customBackground: '#223344', customText: '#eeeeee' });
    await renderLibrary();
    await waitFor(() => expect(document.documentElement.style.backgroundColor).toBe(paint('#223344')));
  });

  it('sepia (the default) paints sepia', async () => {
    await renderLibrary();
    await waitFor(() => expect(document.documentElement.style.backgroundColor).toBe(paint('#f4ecd8')));
  });

  it('the screen is full-bleed: a themed .library with the readable column inside it', async () => {
    const view = await renderLibrary();
    const library = view.container.querySelector('.library')!;
    expect(library.firstElementChild?.classList.contains('library-column')).toBe(true);
    expect(view.container.parentElement?.querySelector('#root')).toBeNull();
  });
});
