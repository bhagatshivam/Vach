import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfPageLoader } from './pdfPageLoader';
import type { PdfPageImageResult, PendingPdfRender } from './pdf';

// jsdom has no real IntersectionObserver - this fake captures each
// constructor call (PdfPageLoader creates exactly two: a small-margin
// "start rendering" observer and a large-margin "evict" observer) so tests
// can fire intersection changes manually. Distinguished by their rootMargin
// (parsed back to a number), not by construction ORDER, so this doesn't
// silently break if PdfPageLoader's constructor is ever reordered.
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  rootMarginPx: number;
  observed = new Set<Element>();
  disconnected = false;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.rootMarginPx = parseInt(String(options?.rootMargin ?? '0'), 10);
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.disconnected = true;
    this.observed.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  fire(entries: Array<{ target: Element; isIntersecting: boolean }>) {
    this.callback(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

function renderObserverOf(): FakeIntersectionObserver {
  return FakeIntersectionObserver.instances.reduce((a, b) => (a.rootMarginPx <= b.rootMarginPx ? a : b));
}
function evictObserverOf(): FakeIntersectionObserver {
  return FakeIntersectionObserver.instances.reduce((a, b) => (a.rootMarginPx >= b.rootMarginPx ? a : b));
}

function makeFigure(pageNumber: number, rectTop: number): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'pdf-page';
  figure.id = `pdf-page-${pageNumber}`;
  figure.getBoundingClientRect = () => ({ top: rectTop, bottom: rectTop + 800, left: 0, right: 375, width: 375, height: 800 }) as DOMRect;
  Object.defineProperty(figure, 'clientWidth', { value: 375, configurable: true });
  const img = document.createElement('img');
  img.className = 'pdf-page-img';
  figure.appendChild(img);
  return figure;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PdfPageLoader', () => {
  let container: HTMLElement;

  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    container.remove();
  });

  it('scan() observes every .pdf-page figure on both observers, and skips already-observed ones on a later call', () => {
    const fig1 = makeFigure(1, 0);
    container.appendChild(fig1);
    const loader = new PdfPageLoader({ container, renderPageImage: () => ({ promise: deferred<PdfPageImageResult | null>().promise, cancel: () => {} }) });
    loader.scan();
    expect(renderObserverOf().observed.size).toBe(1);
    expect(evictObserverOf().observed.size).toBe(1);

    const fig2 = makeFigure(2, 800);
    container.appendChild(fig2);
    loader.scan();
    expect(renderObserverOf().observed.size).toBe(2);
    // fig1 wasn't re-observed (no error, no duplicate) - same Set size proves it.
  });

  it('starts rendering a page once the render observer reports it intersecting', () => {
    const fig1 = makeFigure(1, 0);
    container.appendChild(fig1);
    const calls: number[] = [];
    const pending = deferred<PdfPageImageResult | null>();
    const loader = new PdfPageLoader({
      container,
      renderPageImage: (n) => {
        calls.push(n);
        return { promise: pending.promise, cancel: vi.fn() };
      },
    });
    loader.scan();
    renderObserverOf().fire([{ target: fig1, isIntersecting: true }]);
    expect(calls).toEqual([1]);
  });

  it('respects the default concurrency cap of 2 - a 3rd pending page waits until a slot frees', async () => {
    const figs = [makeFigure(1, 0), makeFigure(2, 800), makeFigure(3, 1600)];
    figs.forEach((f) => container.appendChild(f));
    const calls: number[] = [];
    const pendings = new Map<number, ReturnType<typeof deferred<{ dataUrl: string; byteLength: number; width: number; height: number } | null>>>();
    const loader = new PdfPageLoader({
      container,
      renderPageImage: (n) => {
        calls.push(n);
        const d = deferred<{ dataUrl: string; byteLength: number; width: number; height: number } | null>();
        pendings.set(n, d);
        return { promise: d.promise, cancel: vi.fn() };
      },
    });
    loader.scan();
    renderObserverOf().fire(figs.map((f) => ({ target: f, isIntersecting: true })));

    expect(calls).toEqual([1, 2]); // page 3 queued, not yet started

    pendings.get(1)!.resolve({ dataUrl: 'data:image/jpeg;base64,x', byteLength: 1, width: 10, height: 10 });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([1, 2, 3]);
  });

  it('picks the nearest-to-viewport pending page first, not FIFO order', () => {
    // page1 queued first but far away; page3 queued last but closest.
    const fig1 = makeFigure(1, 5000);
    const fig2 = makeFigure(2, 2000);
    const fig3 = makeFigure(3, 50);
    [fig1, fig2, fig3].forEach((f) => container.appendChild(f));
    const calls: number[] = [];
    const loader = new PdfPageLoader({
      container,
      renderPageImage: (n) => {
        calls.push(n);
        return { promise: deferred<PdfPageImageResult | null>().promise, cancel: vi.fn() };
      },
      maxConcurrent: 1,
    });
    loader.scan();
    // All three become "pending" in id order, but only 1 concurrent slot -
    // the nearest (fig3, top=50) must be the one actually started.
    renderObserverOf().fire([
      { target: fig1, isIntersecting: true },
      { target: fig2, isIntersecting: true },
      { target: fig3, isIntersecting: true },
    ]);
    expect(calls).toEqual([3]);
  });

  it('cancels the in-flight RenderTask when a rendering page leaves the evict window', () => {
    const fig1 = makeFigure(1, 0);
    container.appendChild(fig1);
    const cancel = vi.fn();
    const loader = new PdfPageLoader({
      container,
      renderPageImage: () => ({ promise: deferred<PdfPageImageResult | null>().promise, cancel }),
    });
    loader.scan();
    renderObserverOf().fire([{ target: fig1, isIntersecting: true }]);
    evictObserverOf().fire([{ target: fig1, isIntersecting: false }]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a page cancelled mid-render re-renders from scratch on re-entering the render window (state resets, not stuck)', () => {
    const fig1 = makeFigure(1, 0);
    container.appendChild(fig1);
    const calls: number[] = [];
    const loader = new PdfPageLoader({
      container,
      renderPageImage: (n) => {
        calls.push(n);
        return { promise: deferred<PdfPageImageResult | null>().promise, cancel: vi.fn() };
      },
    });
    loader.scan();
    renderObserverOf().fire([{ target: fig1, isIntersecting: true }]);
    evictObserverOf().fire([{ target: fig1, isIntersecting: false }]);
    renderObserverOf().fire([{ target: fig1, isIntersecting: true }]);
    expect(calls).toEqual([1, 1]);
  });

  it('a stale render result arriving after eviction is discarded, not written into the (now-cleared) placeholder', async () => {
    const fig1 = makeFigure(1, 0);
    container.appendChild(fig1);
    const pending = deferred<{ dataUrl: string; byteLength: number; width: number; height: number } | null>();
    const loader = new PdfPageLoader({
      container,
      renderPageImage: () => ({ promise: pending.promise, cancel: vi.fn() }),
    });
    loader.scan();
    renderObserverOf().fire([{ target: fig1, isIntersecting: true }]);
    evictObserverOf().fire([{ target: fig1, isIntersecting: false }]); // evicted mid-render (cancel() called, but the real render ignores cancel in this fake and resolves anyway below)
    pending.resolve({ dataUrl: 'data:image/jpeg;base64,late', byteLength: 1, width: 1, height: 1 });
    await Promise.resolve();
    await Promise.resolve();
    const img = fig1.querySelector('img.pdf-page-img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBeNull();
  });

  it('clears an already-rendered image back to an empty placeholder once evicted', async () => {
    const fig1 = makeFigure(1, 0);
    container.appendChild(fig1);
    const pending = deferred<{ dataUrl: string; byteLength: number; width: number; height: number } | null>();
    const loader = new PdfPageLoader({
      container,
      renderPageImage: () => ({ promise: pending.promise, cancel: vi.fn() }),
    });
    loader.scan();
    renderObserverOf().fire([{ target: fig1, isIntersecting: true }]);
    pending.resolve({ dataUrl: 'data:image/jpeg;base64,abc', byteLength: 3, width: 10, height: 10 });
    await Promise.resolve();
    await Promise.resolve();
    const img = fig1.querySelector('img.pdf-page-img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,abc');

    evictObserverOf().fire([{ target: fig1, isIntersecting: false }]);
    expect(img.getAttribute('src')).toBeNull();
  });

  it('a page between the two margins (not within render range, not yet past evict range) is left alone - the hysteresis dead zone', () => {
    const fig1 = makeFigure(1, 0);
    container.appendChild(fig1);
    const calls: number[] = [];
    const loader = new PdfPageLoader({
      container,
      renderPageImage: (n) => {
        calls.push(n);
        return { promise: deferred<PdfPageImageResult | null>().promise, cancel: vi.fn() };
      },
    });
    loader.scan();
    // Never told it's within the render margin - no render call should happen.
    evictObserverOf().fire([{ target: fig1, isIntersecting: true }]); // still within the (larger) evict margin, nothing to evict yet
    expect(calls).toEqual([]);
  });

  it('a render that resolves to null (failed to rasterize) leaves the page unrendered without throwing, and does not block the queue', async () => {
    const fig1 = makeFigure(1, 0);
    const fig2 = makeFigure(2, 800);
    [fig1, fig2].forEach((f) => container.appendChild(f));
    const pending1 = deferred<PdfPageImageResult | null>();
    const calls: number[] = [];
    const loader = new PdfPageLoader({
      container,
      renderPageImage: (n) => {
        calls.push(n);
        if (n === 1) return { promise: pending1.promise, cancel: vi.fn() };
        return { promise: Promise.resolve(null), cancel: vi.fn() };
      },
      maxConcurrent: 1,
    });
    loader.scan();
    renderObserverOf().fire([
      { target: fig1, isIntersecting: true },
      { target: fig2, isIntersecting: true },
    ]);
    pending1.resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([1, 2]);
    const img1 = fig1.querySelector('img.pdf-page-img') as HTMLImageElement;
    expect(img1.getAttribute('src')).toBeNull();
  });

  it('a render promise that rejects is caught, logged, and does not block the queue', async () => {
    const fig1 = makeFigure(1, 0);
    container.appendChild(fig1);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending: PendingPdfRender = { promise: Promise.reject(new Error('boom')), cancel: vi.fn() };
    const loader = new PdfPageLoader({ container, renderPageImage: () => pending });
    loader.scan();
    expect(() => renderObserverOf().fire([{ target: fig1, isIntersecting: true }])).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('destroy() disconnects both observers and cancels every in-flight render', () => {
    const fig1 = makeFigure(1, 0);
    container.appendChild(fig1);
    const cancel = vi.fn();
    const loader = new PdfPageLoader({
      container,
      renderPageImage: () => ({ promise: deferred<PdfPageImageResult | null>().promise, cancel }),
    });
    loader.scan();
    renderObserverOf().fire([{ target: fig1, isIntersecting: true }]);
    loader.destroy();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(renderObserverOf().disconnected).toBe(true);
    expect(evictObserverOf().disconnected).toBe(true);
  });

  it('scan() after destroy() is a no-op (does not throw, does not observe)', () => {
    const fig1 = makeFigure(1, 0);
    container.appendChild(fig1);
    const loader = new PdfPageLoader({ container, renderPageImage: () => ({ promise: deferred<PdfPageImageResult | null>().promise, cancel: () => {} }) });
    loader.destroy();
    expect(() => loader.scan()).not.toThrow();
    expect(renderObserverOf().observed.size).toBe(0);
  });
});
