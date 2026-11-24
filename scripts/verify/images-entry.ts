// Runs INSIDE headless Chromium (bundled by images-chromium.mjs): the reader's real DOM and CSS,
// the real sanitizer + image pipeline + controller, the real lightbox, real layout.
import '../../src/index.css';
import '../../src/App.css';
import JSZip from 'jszip';
import { archiveFromJSZip, openEpub, type EpubBook } from '../../src/lib/epub';
import { ImageController } from '../../src/lib/imageController';
import { displayWidthCap, isOwnBlobUrl, LIGHTBOX_MAX_SIDE_PX } from '../../src/lib/imageProcessor';
import { doubleTap, drag, lightboxIsOpen, mountLightbox, pinchGesture, sleep, tap, unmountLightbox, view } from './lightboxDriver';

const toBytes = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const frames = (n: number) => new Promise<void>((resolve) => { const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1))); step(n); });

let book: EpubBook | null = null;
let controller: ImageController | null = null;
let content: HTMLElement | null = null;
let cls = 0;
const everSeenUrls = new Set<string>();
let observer: PerformanceObserver | null = null;

const chapters = (): HTMLElement[] => Array.from(content!.querySelectorAll(':scope > .chapter'));
const imgs = (): HTMLImageElement[] => Array.from(content!.querySelectorAll('img'));
const absTop = (el: Element) => el.getBoundingClientRect().top + window.scrollY;

function overflow() {
  const box = content!.getBoundingClientRect();
  let worst = 0;
  let worstTag = '';
  for (const el of Array.from(content!.querySelectorAll('*'))) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const amount = Math.max(rect.right - box.right, box.left - rect.left);
    if (amount > worst) { worst = amount; worstTag = el.tagName.toLowerCase(); }
  }
  const previous = content!.style.overflowX;
  content!.style.overflowX = 'visible';
  const scrollWidth = content!.scrollWidth;
  const clientWidth = content!.clientWidth;
  const pageScrollWidth = document.documentElement.scrollWidth;
  content!.style.overflowX = previous;
  return { scrollWidth, clientWidth, pageScrollWidth, innerWidth: window.innerWidth, worst: Math.round(worst * 10) / 10, worstTag, ok: scrollWidth <= clientWidth && pageScrollWidth <= window.innerWidth && worst <= 0.5 };
}

function snapshot() {
  return chapters().flatMap((chapter, ci) => Array.from(chapter.children).map((el, i) => ({ key: `${ci}:${i}:${el.tagName}`, top: absTop(el), height: el.getBoundingClientRect().height })));
}

const track = () => imgs().forEach((img) => img.getAttribute('src') && everSeenUrls.add(img.getAttribute('src')!));

const api = {
  async load(base64: string, theme: 'sepia' | 'night' = 'sepia') {
    controller?.destroy();
    unmountLightbox();
    observer?.disconnect();
    cls = 0;
    everSeenUrls.clear();
    document.body.innerHTML = '';
    window.scrollTo(0, 0);
    // Real Layout Instability API: the browser's own measure of things jumping.
    observer = new PerformanceObserver((list) => { for (const entry of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!entry.hadRecentInput) cls += entry.value; });
    observer.observe({ type: 'layout-shift', buffered: true });

    book = await openEpub(archiveFromJSZip(await JSZip.loadAsync(toBytes(base64))), 'sample');
    const reader = document.createElement('div');
    reader.className = 'reader';
    reader.dataset.theme = theme;
    reader.style.cssText = theme === 'night' ? 'background:#1c1917;color:#d6d3d1' : 'background:#f4ecd8;color:#3b2f1e';
    content = document.createElement('div');
    content.className = 'reader-content';
    content.style.cssText = 'font-family: Georgia, serif; font-size: 18px; line-height: 1.6';
    reader.append(content);
    document.body.append(reader);

    for (let i = 0; i < book.chapterCount; i++) {
      const section = document.createElement('section');
      section.className = 'chapter';
      section.innerHTML = await book.loadChapter(i);
      content.append(section);
    }
    track();
    return { chapters: book.chapterCount, images: imgs().length, srcs: imgs().map((i) => i.getAttribute('src')!), dataUris: content.innerHTML.includes('src="data:') };
  },

  snapshot,
  track,

  /** Start the controller and scroll through the whole book, as reading does, then wait until nothing is pending. */
  async processAll() {
    controller = new ImageController(book!.images);
    for (const section of chapters()) controller.register(section);
    const total = document.documentElement.scrollHeight;
    for (let y = 0; y <= total; y += Math.max(150, window.innerHeight / 3)) {
      window.scrollTo(0, y);
      await frames(2);
      await sleep(40);
    }
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline) {
      track();
      const pending = imgs().filter((img) => (img.getAttribute('src') ?? '').includes('#vach-'));
      const loading = imgs().filter((img) => !img.complete);
      if (pending.length === 0 && loading.length === 0) break;
      window.scrollTo(0, window.scrollY); // keep nudging the observers
      await sleep(100);
    }
    track();
    window.scrollTo(0, 0);
    await frames(3);
    await sleep(200);
    return { stillPending: imgs().filter((img) => (img.getAttribute('src') ?? '').includes('#vach-')).length, cls };
  },

  cls: () => cls,
  overflow,

  imageReport() {
    const cap = displayWidthCap(window.innerWidth, window.devicePixelRatio);
    return {
      cap,
      images: imgs().map((img) => {
        const rect = img.getBoundingClientRect();
        return {
          alt: img.alt,
          natural: [img.naturalWidth, img.naturalHeight] as [number, number],
          shown: [Math.round(rect.width * 10) / 10, Math.round(rect.height * 10) / 10] as [number, number],
          src: (img.getAttribute('src') ?? '').slice(0, 24),
          own: isOwnBlobUrl(img.getAttribute('src') ?? ''),
          inline: img.style.display === 'inline-block',
          attrs: [img.getAttribute('width'), img.getAttribute('height')] as [string | null, string | null],
          aspect: img.style.aspectRatio,
          filter: getComputedStyle(img).filter,
          loading: img.getAttribute('loading'),
          decoding: img.getAttribute('decoding'),
        };
      }),
      viewportHeight: window.innerHeight,
      contentWidth: content!.clientWidth,
    };
  },

  // ---- lightbox --------------------------------------------------------------------
  async openLightbox(alt: string, canInvert = false) {
    const img = imgs().find((i) => i.alt === alt)!;
    const store = book!.images;
    const src = img.getAttribute('src')!;
    const info = store.describe(src)!;
    await mountLightbox({
      label: 'Image',
      image: { src: store.isPending(src) ? undefined : src, width: info.width!, height: info.height!, alt },
      loadFull: () => store.full(src),
      canInvert,
    });
    // Wait for the full-detail copy to arrive.
    const shownImage = () => document.querySelector<HTMLImageElement>('.lightbox-image');
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      const el = shownImage();
      if (el && el.complete && el.naturalWidth > 0 && el.src !== src) break;
      await sleep(50);
    }
    const el = shownImage()!;
    everSeenUrls.add(el.src);
    return { natural: [el.naturalWidth, el.naturalHeight] as [number, number], max: LIGHTBOX_MAX_SIDE_PX, fullUrl: el.src, ...api.lightboxView() };
  },
  lightboxView: () => view(),
  isOpen: () => lightboxIsOpen(),
  closeLightbox: () => unmountLightbox(),
  invertFilter: () => getComputedStyle(document.querySelector('.lightbox-image')!).filter,
  clickInvert: () => document.querySelector<HTMLButtonElement>('.lightbox-invert')!.click(),
  liveUrlCount: () => book!.images.liveUrlCount,
  doubleTap, drag, pinchGesture, tap, sleep,

  /** Close the book, then try to fetch every blob URL it ever gave out. */
  async closeBook() {
    track();
    const urls = [...new Set([...everSeenUrls].filter((u) => u.startsWith('blob:')).map((u) => u.split('#')[0]))];
    const before: boolean[] = [];
    for (const url of urls) before.push(await fetch(url).then((r) => r.ok, () => false));
    unmountLightbox();
    book!.close();
    const after: boolean[] = [];
    for (const url of urls) after.push(await fetch(url).then((r) => r.ok, () => false));
    return { urls: urls.length, loadableBefore: before.filter(Boolean).length, loadableAfter: after.filter(Boolean).length, live: book!.images.liveUrlCount };
  },
};

(globalThis as unknown as { verify: typeof api }).verify = api;
