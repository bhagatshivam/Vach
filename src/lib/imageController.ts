// Decides WHEN an image is downscaled: only once it is near the viewport, so a
// book with hundreds of pictures does no work for the ones nobody scrolls to.
// Like the table controller it is DOM glue: chapters register after they mount,
// it watches their still-pending <img>s, asks the ImageStore to downscale each
// as it comes near (the store runs at most two at a time) and swaps the result
// in. The swap changes only the src - the box was already reserved at its final
// size (see stampImage in epub.ts) - so nothing on the page moves.

import type { ImageStore } from './imageProcessor';

export interface ImageControllerOptions {
  /** How far outside the viewport an image counts as "near" (IntersectionObserver rootMargin). */
  rootMargin?: string;
}

export class ImageController {
  private readonly store: ImageStore;
  private readonly observer: IntersectionObserver | null;
  /** Placeholder src -> the <img> elements currently showing it. */
  private readonly waiting = new Map<string, Set<HTMLImageElement>>();
  private destroyed = false;

  constructor(store: ImageStore, options: ImageControllerOptions = {}) {
    this.store = store;
    this.observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) if (entry.isIntersecting) this.request(entry.target as HTMLImageElement);
            },
            { rootMargin: options.rootMargin ?? '150% 0px 150% 0px' },
          );
  }

  /** Starts watching the pending images of a mounted chapter. Returns the function that stops. */
  register(section: HTMLElement): () => void {
    if (this.destroyed) return () => {};
    const mine: HTMLImageElement[] = [];
    for (const img of Array.from(section.querySelectorAll('img'))) {
      const src = img.getAttribute('src');
      if (!src) continue;
      const current = this.store.currentUrl(src);
      if (current !== src) {
        img.setAttribute('src', current); // already downscaled (a picture shared with an earlier chapter)
        continue;
      }
      if (!this.store.isPending(src)) continue;

      let set = this.waiting.get(src);
      if (!set) this.waiting.set(src, (set = new Set()));
      set.add(img);
      mine.push(img);
      if (this.observer) this.observer.observe(img);
      else this.request(img); // no IntersectionObserver: do them all, in order
    }
    return () => {
      for (const img of mine) this.forget(img);
    };
  }

  private forget(img: HTMLImageElement): void {
    this.observer?.unobserve(img);
    const src = img.getAttribute('src');
    if (!src) return;
    const set = this.waiting.get(src);
    set?.delete(img);
    if (set && set.size === 0) this.waiting.delete(src);
  }

  private request(img: HTMLImageElement): void {
    const src = img.getAttribute('src');
    if (!src || this.destroyed) return;
    this.observer?.unobserve(img);
    void this.store.process(src).then((url) => {
      if (!url || this.destroyed) return; // failed or closed: the placeholder stays, never a throw into the reader
      const set = this.waiting.get(src);
      if (!set) return;
      for (const waiting of set) if (waiting.getAttribute('src') === src) waiting.setAttribute('src', url);
      this.waiting.delete(src);
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.observer?.disconnect();
    this.waiting.clear();
  }
}
