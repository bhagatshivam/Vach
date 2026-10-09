import type { PendingPdfRender } from './pdf';

// Lazy, windowed rendering for PDF page-image placeholders already present
// in the DOM (see buildPagePlaceholder in pdf.ts - each is a
// <figure class="pdf-page" id="pdf-page-N"><img class="pdf-page-img"></figure>
// with its box height already reserved via CSS aspect-ratio, so none of
// this can ever cause a layout shift).
//
// Two independent IntersectionObservers, not one, is what gives this
// hysteresis: a page starts rendering once it comes within RENDER_MARGIN
// screens of the viewport, but isn't evicted again until it's past the
// larger EVICT_MARGIN screens - the gap between the two margins is a dead
// zone where a page that's already rendered stays rendered, and a page
// that isn't hasn't started yet, so scrolling back and forth near either
// boundary alone doesn't repeatedly render/evict the same page.
const RENDER_MARGIN_SCREENS = 2;
const EVICT_MARGIN_SCREENS = 6;
const DEFAULT_MAX_CONCURRENT = 2;

type PageState = 'unrendered' | 'pending' | 'rendering' | 'rendered';

function pageNumberOf(el: Element): number | null {
  const match = /^pdf-page-(\d+)$/.exec(el.id);
  return match ? Number(match[1]) : null;
}

export interface PdfPageLoaderOptions {
  container: HTMLElement;
  renderPageImage: (pageNumber: number, viewportWidthPx: number, devicePixelRatio: number) => PendingPdfRender;
  maxConcurrent?: number;
}

/**
 * Drives rendering/eviction for every `.pdf-page` placeholder inside
 * `container`. Call scan() whenever new placeholders may have been added to
 * the DOM (e.g. after a new page streams in) - already-observed elements
 * are skipped, so this is safe to call repeatedly. Call destroy() once, on
 * unmount, to disconnect both observers and cancel any in-flight renders.
 */
export class PdfPageLoader {
  private readonly container: HTMLElement;
  private readonly renderPageImage: PdfPageLoaderOptions['renderPageImage'];
  private readonly maxConcurrent: number;
  private readonly renderObserver: IntersectionObserver;
  private readonly evictObserver: IntersectionObserver;
  private readonly observed = new Set<Element>();
  private readonly state = new Map<number, PageState>();
  private readonly inFlight = new Map<number, PendingPdfRender>();
  private readonly pendingQueue = new Set<number>();
  private destroyed = false;

  constructor(options: PdfPageLoaderOptions) {
    this.container = options.container;
    this.renderPageImage = options.renderPageImage;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

    const screenHeight = window.innerHeight || 800;
    this.renderObserver = new IntersectionObserver(this.handleRenderIntersect, {
      rootMargin: `${Math.round(screenHeight * RENDER_MARGIN_SCREENS)}px 0px`,
    });
    this.evictObserver = new IntersectionObserver(this.handleEvictIntersect, {
      rootMargin: `${Math.round(screenHeight * EVICT_MARGIN_SCREENS)}px 0px`,
    });
  }

  /** Starts observing any `.pdf-page` placeholder not already known to this loader. */
  scan(): void {
    if (this.destroyed) return;
    const figures = this.container.querySelectorAll<HTMLElement>('figure.pdf-page');
    for (const figure of Array.from(figures)) {
      if (this.observed.has(figure)) continue;
      const pageNumber = pageNumberOf(figure);
      if (pageNumber === null) continue;
      this.observed.add(figure);
      this.state.set(pageNumber, 'unrendered');
      this.renderObserver.observe(figure);
      this.evictObserver.observe(figure);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.renderObserver.disconnect();
    this.evictObserver.disconnect();
    for (const pending of this.inFlight.values()) pending.cancel();
    this.inFlight.clear();
    this.pendingQueue.clear();
  }

  private handleRenderIntersect = (entries: IntersectionObserverEntry[]): void => {
    if (this.destroyed) return;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const pageNumber = pageNumberOf(entry.target);
      if (pageNumber === null) continue;
      if (this.state.get(pageNumber) === 'unrendered') {
        this.state.set(pageNumber, 'pending');
        this.pendingQueue.add(pageNumber);
      }
    }
    this.pump();
  };

  private handleEvictIntersect = (entries: IntersectionObserverEntry[]): void => {
    if (this.destroyed) return;
    for (const entry of entries) {
      if (entry.isIntersecting) continue;
      const pageNumber = pageNumberOf(entry.target);
      if (pageNumber === null) continue;
      const current = this.state.get(pageNumber);
      if (current === 'rendering') {
        this.inFlight.get(pageNumber)?.cancel();
        this.inFlight.delete(pageNumber);
        this.pendingQueue.delete(pageNumber);
        this.state.set(pageNumber, 'unrendered');
      } else if (current === 'rendered') {
        this.clearRenderedImage(entry.target as HTMLElement);
        this.state.set(pageNumber, 'unrendered');
      } else if (current === 'pending') {
        this.pendingQueue.delete(pageNumber);
        this.state.set(pageNumber, 'unrendered');
      }
    }
  };

  private pump(): void {
    while (this.inFlight.size < this.maxConcurrent && this.pendingQueue.size > 0) {
      const next = this.pickNearest();
      if (next === null) break;
      this.pendingQueue.delete(next);
      this.startRender(next);
    }
  }

  // Nearest-first: among everything waiting to render, picks the one whose
  // placeholder is closest to the viewport (by either edge) right now - so
  // if several pages enter the render window in the same scroll event, the
  // one the reader will actually reach first finishes first.
  private pickNearest(): number | null {
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const pageNumber of this.pendingQueue) {
      const figure = this.findFigure(pageNumber);
      if (!figure) continue;
      const rect = figure.getBoundingClientRect();
      const distance = Math.min(Math.abs(rect.top), Math.abs(rect.bottom));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = pageNumber;
      }
    }
    return best;
  }

  private findFigure(pageNumber: number): HTMLElement | null {
    return this.container.querySelector<HTMLElement>(`#pdf-page-${pageNumber}`);
  }

  private startRender(pageNumber: number): void {
    const figure = this.findFigure(pageNumber);
    if (!figure) {
      this.state.set(pageNumber, 'unrendered');
      return;
    }
    this.state.set(pageNumber, 'rendering');
    const viewportWidthPx = figure.clientWidth || window.innerWidth || 375;
    const devicePixelRatio = window.devicePixelRatio || 1;
    const pending = this.renderPageImage(pageNumber, viewportWidthPx, devicePixelRatio);
    this.inFlight.set(pageNumber, pending);

    pending.promise
      .then((result) => {
        this.inFlight.delete(pageNumber);
        if (this.destroyed) return;
        // Only act if still in the 'rendering' state - a mid-flight evict
        // or cancel already moved it back to 'unrendered', and applying a
        // now-stale result on top of that would resurrect a page the
        // reader has since scrolled away from.
        if (this.state.get(pageNumber) !== 'rendering') return;
        if (result) {
          const img = figure.querySelector<HTMLImageElement>('img.pdf-page-img');
          if (img) img.src = result.dataUrl;
          this.state.set(pageNumber, 'rendered');
        } else {
          this.state.set(pageNumber, 'unrendered');
        }
        this.pump();
      })
      .catch((err) => {
        console.error('[pdf] failed to rasterize page', pageNumber, err);
        this.inFlight.delete(pageNumber);
        if (this.destroyed) return;
        if (this.state.get(pageNumber) === 'rendering') this.state.set(pageNumber, 'unrendered');
        this.pump();
      });
  }

  private clearRenderedImage(figure: HTMLElement): void {
    const img = figure.querySelector<HTMLImageElement>('img.pdf-page-img');
    if (img) img.removeAttribute('src');
  }
}
