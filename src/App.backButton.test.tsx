import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Mirrors Capacitor's real listener model (WebPlugin.addListener/
// notifyListeners): an array of callbacks per event name, and a notify
// helper that invokes *every* registered callback - not a stub that only
// ever has one callback to call. This is the actual thing being verified:
// if App.tsx (or anything else) ever registered a second 'backButton'
// listener, __notifyListeners would invoke both of them, exactly as
// Capacitor would on a real device, and a test built on this would catch
// the double-handling (sheet closes *and* the app exits on one press) that
// a single-callback stub can't see.
vi.mock('@capacitor/app', () => {
  const listeners = new Map<string, Array<(data?: unknown) => void>>();
  const exitApp = vi.fn();
  const addListener = vi.fn((eventName: string, cb: (data?: unknown) => void) => {
    const arr = listeners.get(eventName) ?? [];
    arr.push(cb);
    listeners.set(eventName, arr);
    return Promise.resolve({
      remove: async () => {
        listeners.set(
          eventName,
          (listeners.get(eventName) ?? []).filter((l) => l !== cb),
        );
      },
    });
  });
  return {
    App: { addListener, exitApp },
    // data is forwarded to every callback, same as Capacitor's real
    // notifyListeners(eventName, data) - 'appStateChange' listeners expect
    // an AppState payload ({isActive}), not a bare call.
    __notifyListeners: (eventName: string, data?: unknown) => {
      for (const cb of listeners.get(eventName) ?? []) cb(data);
    },
    __listenerCount: (eventName: string) => (listeners.get(eventName) ?? []).length,
  };
});

// LibraryScreen's native-plugin dependency - irrelevant to back-button
// wiring for most tests here, but one test below actually opens a book (to
// mount ReaderScreen, which is where appStateChange gets registered), so a
// real file + a working readFileBase64 are included too.
vi.mock('./lib/libraryFolder', () => ({
  scanAllSources: vi.fn(async () => ({
    sources: [{ source: { type: 'folder', uri: 'content://x' }, displayName: 'Books' }],
    files: [{ name: 'book.epub', uri: 'content://x/book.epub', path: 'book.epub', size: 1 }],
    failedSources: [],
  })),
  addFolderSource: vi.fn(async () => {}),
  addFileSources: vi.fn(async () => {}),
  removeSource: vi.fn(async () => {}),
  readFileBase64: vi.fn(async () => 'dGVzdA=='),
}));

// ReaderScreen dynamically imports epub.ts/pdf.ts - mocked here (not real
// parsing) purely so opening a book resolves quickly and deterministically,
// with no saved position so content reveals immediately and the
// appStateChange listener registers right away.
vi.mock('./lib/epub', () => ({
  streamEpub: async function* () {
    yield { type: 'title', title: 'Test Book' };
    yield { type: 'total', count: 1 };
    yield { type: 'chapter', html: '<p>one paragraph</p>' };
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderApp() {
  const { default: App } = await import('./App');
  return render(<App />);
}

describe('hardware back button + sources sheet (realistic multi-listener simulation)', () => {
  it('registers exactly one backButton listener with Capacitor', async () => {
    await renderApp();
    await screen.findByLabelText('Sources and settings');

    const { __listenerCount } = (await import('@capacitor/app')) as unknown as {
      __listenerCount: (e: string) => number;
    };
    expect(__listenerCount('backButton')).toBe(1);
  });

  it('a back press while the sources sheet is open closes the sheet and does not exit the app', async () => {
    await renderApp();
    const gearButton = await screen.findByLabelText('Sources and settings');

    fireEvent.click(gearButton);
    expect(await screen.findByText('Sources')).toBeTruthy();

    const { App: CapacitorApp, __notifyListeners } = (await import('@capacitor/app')) as unknown as {
      App: { exitApp: ReturnType<typeof vi.fn> };
      __notifyListeners: (e: string) => void;
    };

    act(() => __notifyListeners('backButton'));

    expect(screen.queryByText('Sources')).toBeNull();
    expect(CapacitorApp.exitApp).not.toHaveBeenCalled();
  });

  it('a back press at the library root (no sheet open) exits the app, not the sheet-close path', async () => {
    await renderApp();
    await screen.findByLabelText('Sources and settings');

    const { App: CapacitorApp, __notifyListeners } = (await import('@capacitor/app')) as unknown as {
      App: { exitApp: ReturnType<typeof vi.fn> };
      __notifyListeners: (e: string) => void;
    };

    act(() => __notifyListeners('backButton'));

    expect(CapacitorApp.exitApp).toHaveBeenCalledTimes(1);
  });

  it('closing the sheet via its own close button also clears the back-button hook (a later back press falls through to exit)', async () => {
    await renderApp();
    const gearButton = await screen.findByLabelText('Sources and settings');
    fireEvent.click(gearButton);
    await screen.findByText('Sources');

    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByText('Sources')).toBeNull();

    const { App: CapacitorApp, __notifyListeners } = (await import('@capacitor/app')) as unknown as {
      App: { exitApp: ReturnType<typeof vi.fn> };
      __notifyListeners: (e: string) => void;
    };

    act(() => __notifyListeners('backButton'));
    expect(CapacitorApp.exitApp).toHaveBeenCalledTimes(1);
  });

  it('with a book open (appStateChange now also registered by ReaderScreen): backButton count stays 1, appStateChange never fires exitApp, and backButton never fires an appStateChange handler', async () => {
    await renderApp();
    const bookRow = await screen.findByText('book');
    fireEvent.click(bookRow);

    // Wait for the reader to actually mount and reveal content (no saved
    // position for this book, so reveal is immediate) - this is the point
    // at which ReaderScreen's appStateChange effect registers.
    await screen.findByText('one paragraph');

    const { __listenerCount, __notifyListeners, App: CapacitorApp } = (await import('@capacitor/app')) as unknown as {
      __listenerCount: (e: string) => number;
      __notifyListeners: (e: string, data?: unknown) => void;
      App: { exitApp: ReturnType<typeof vi.fn> };
    };

    expect(__listenerCount('backButton')).toBe(1);
    expect(__listenerCount('appStateChange')).toBe(1);

    // Firing appStateChange (app backgrounded) must not touch backButton's
    // job - exitApp must not be called just because the app backgrounded.
    act(() => __notifyListeners('appStateChange', { isActive: false }));
    expect(CapacitorApp.exitApp).not.toHaveBeenCalled();

    // Firing backButton from inside the reader navigates back to the
    // library (the existing reader-vs-library branch), not exitApp, and
    // must not be affected by appStateChange's listener existing alongside it.
    act(() => __notifyListeners('backButton'));
    expect(CapacitorApp.exitApp).not.toHaveBeenCalled();
    expect(await screen.findByLabelText('Sources and settings')).toBeTruthy();
  });
});
