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
  const listeners = new Map<string, Array<() => void>>();
  const exitApp = vi.fn();
  const addListener = vi.fn((eventName: string, cb: () => void) => {
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
    __notifyListeners: (eventName: string) => {
      for (const cb of listeners.get(eventName) ?? []) cb();
    },
    __listenerCount: (eventName: string) => (listeners.get(eventName) ?? []).length,
  };
});

// LibraryScreen's native-plugin dependency - irrelevant to back-button
// wiring, stubbed to an empty library so the screen renders its normal
// (non-empty-state) chrome, which is what exposes the sources sheet/gear
// button this test needs.
vi.mock('./lib/libraryFolder', () => ({
  scanAllSources: vi.fn(async () => ({
    sources: [{ source: { type: 'folder', uri: 'content://x' }, displayName: 'Books' }],
    files: [],
    failedSources: [],
  })),
  addFolderSource: vi.fn(async () => {}),
  addFileSources: vi.fn(async () => {}),
  removeSource: vi.fn(async () => {}),
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
});
