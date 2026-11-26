// Runs INSIDE headless Chromium (bundled by frame-chromium.mjs): the REAL LibraryScreen, ReaderScreen, index.css,
// App.css and frame.css, with the native file layer stubbed out.
import { createRoot, type Root } from 'react-dom/client';
import { createRef } from 'react';
import '../../src/index.css';
import '../../src/App.css';
import '../../src/frame.css';
import LibraryScreen from '../../src/screens/LibraryScreen';
import ReaderScreen from '../../src/screens/ReaderScreen';
import { resetSystemThemeForTests } from '../../src/lib/systemTheme';
import { savePosition } from '../../src/lib/readingPosition';

let root: Root | null = null;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const api = {
  async show(screen: 'library-empty' | 'library-books' | 'reader', settings: object, insets: { top: number; bottom: number; left: number; right: number } | null, savedChapter?: number, fileName = 'sample.epub') {
    root?.unmount();
    document.body.innerHTML = '<div id="root"></div>';
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    resetSystemThemeForTests();
    window.scrollTo(0, 0);
    localStorage.clear();
    localStorage.setItem('CapacitorStorage.reader_settings', JSON.stringify(settings));
    // What Capacitor's SystemBars plugin injects on a phone.
    if (insets) {
      const s = document.documentElement.style;
      s.setProperty('--safe-area-inset-top', `${insets.top}px`);
      s.setProperty('--safe-area-inset-bottom', `${insets.bottom}px`);
      s.setProperty('--safe-area-inset-left', `${insets.left}px`);
      s.setProperty('--safe-area-inset-right', `${insets.right}px`);
    }
    // A reader coming back to a book: open it at a saved position (this is what the real app does on a reopen).
    if (savedChapter !== undefined) await savePosition({ name: fileName, size: 1 }, { chapterIndex: savedChapter, blockIndex: 2, blockFraction: 0.3 }, 0.4);
    (window as unknown as { __libraryMode: string }).__libraryMode = screen === 'library-books' ? 'books' : 'empty';
    root = createRoot(document.getElementById('root')!);
    const ref = createRef<(() => void) | null>() as { current: (() => void) | null };
    if (screen === 'reader') {
      root.render(<ReaderScreen file={{ name: fileName, uri: `content://x/${fileName}`, path: fileName, size: 1 }} onBack={() => {}} />);
      for (let i = 0; i < 200 && !document.querySelector('.reader-content:not(.pre-reveal) .chapter'); i++) await sleep(50);
    } else {
      root.render(<LibraryScreen onOpenBook={() => {}} sheetCloseRef={ref} />);
      for (let i = 0; i < 200 && !document.querySelector(screen === 'library-empty' ? '.empty-state' : '.book-row'); i++) await sleep(50);
    }
    await sleep(300); // the theme is applied after settings load
  },

  /** Opens the Contents drawer (the reader must be showing) and waits for it to settle. */
  async openToc() {
    for (let i = 0; i < 200 && !document.querySelector('button[aria-label="Contents"]'); i++) await sleep(50);
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Contents"]');
    if (!button) return false;
    button.click();
    for (let i = 0; i < 100 && !document.querySelector('.toc-panel'); i++) await sleep(50);
    await sleep(400); // the slide-in
    return Boolean(document.querySelector('.toc-panel'));
  },

  measureToc() {
    const panel = document.querySelector<HTMLElement>('.toc-panel')!;
    const rect = panel.getBoundingClientRect();
    const title = panel.querySelector('h2')!.getBoundingClientRect();
    const scroll = panel.querySelector<HTMLElement>('.toc-scroll')!;
    const scrollRect = scroll.getBoundingClientRect();
    const current = panel.querySelector<HTMLElement>('[aria-current="true"]');
    const currentRect = current?.getBoundingClientRect();
    return {
      panelLeft: rect.left,
      panelRight: rect.right,
      panelTop: rect.top,
      panelBottom: rect.bottom,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      titleTop: title.top,
      scrollWidth: document.documentElement.scrollWidth,
      listScrollWidth: scroll.scrollWidth,
      listClientWidth: scroll.clientWidth,
      entries: panel.querySelectorAll('.toc-item').length,
      currentText: current?.textContent ?? null,
      currentVisible: currentRect ? currentRect.top >= scrollRect.top - 1 && currentRect.bottom <= scrollRect.bottom + 1 : null,
      panelBackground: getComputedStyle(panel).backgroundColor,
      percent: panel.querySelector('.toc-percent')?.textContent ?? null,
    };
  },

  /**
   * Taps a Contents entry by its title (opening the drawer first if needed), waits until the reader has settled, and
   * reports what is on screen. Used by toc-jump-chromium.mjs: this is the same path a finger takes.
   */
  async jumpTo(title: string) {
    if (!document.querySelector('.toc-panel')) await api.openToc();
    const find = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.toc-item')).find((b) => b.textContent === title);
    // A deeply nested book starts with its groups collapsed: open them all if the entry is not showing.
    if (!find()) {
      document.querySelectorAll<HTMLButtonElement>('.toc-toggle[aria-expanded="false"]').forEach((b) => b.click());
      await sleep(100);
    }
    const entry = find();
    if (!entry) return { error: `no Contents entry "${title}"` };
    entry.scrollIntoView({ block: 'center' });
    entry.click();
    for (let i = 0; i < 300; i++) {
      await sleep(50);
      const settled = !document.querySelector('.toc-panel') && !document.querySelector('.restore-overlay') && document.querySelector('.reader-content:not(.pre-reveal)');
      if (settled && i > 6) break;
    }
    await sleep(700); // late layout, the post-jump verification and any neighbours being loaded
    return api.screen();
  },

  /** What the reader is showing right now: which chapters are on screen and whether anything is blank. */
  screen() {
    const content = document.querySelector<HTMLElement>('.reader-content');
    const chapters = Array.from(content?.querySelectorAll<HTMLElement>(':scope > .chapter') ?? []);
    const vh = window.innerHeight;
    const visible = chapters
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height > 0 && rect.bottom > 1 && rect.top < vh - 1)
      .map(({ el, rect }) => ({ marker: /MARK_(\d+)/.exec(el.textContent ?? '')?.[1] ?? '?', text: (el.textContent ?? '').slice(0, 40), top: Math.round(rect.top), bottom: Math.round(rect.bottom) }));
    const covered = visible.reduce((n, v) => n + Math.max(0, Math.min(v.bottom, vh) - Math.max(v.top, 0)), 0);
    const marks = chapters.map((el) => Number(/MARK_(\d+)/.exec(el.textContent ?? '')?.[1] ?? -1));
    return {
      scrollY: Math.round(window.scrollY),
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: vh,
      mounted: marks.length > 0 ? [marks[0], marks[marks.length - 1], marks.length] : [],
      visible,
      /** Share of the viewport height covered by chapter content. */
      coveredShare: Math.round((covered / vh) * 100) / 100,
      contentVisibility: content ? getComputedStyle(content).visibility : 'none',
      overlay: Boolean(document.querySelector('.restore-overlay')),
      drawer: Boolean(document.querySelector('.toc-panel')),
      loadingMore: Boolean(document.querySelector('.loading-more')),
    };
  },

  /** Taps an internal link (a Word footnote number, a cross-reference) by the id it points to, and waits for the jump. */
  async clickLink(id: string) {
    const link = document.querySelector<HTMLElement>(`[data-vach-link="${id}"]`);
    if (!link) return { error: `no link to "${id}" is mounted` };
    link.click();
    for (let i = 0; i < 300; i++) {
      await sleep(50);
      const settled = !document.querySelector('.restore-overlay') && document.querySelector('.reader-content:not(.pre-reveal)');
      if (settled && i > 6) break;
    }
    await sleep(700);
    return api.anchorInView(id);
  },

  /** Where the element carrying anchor `id` is relative to the screen. */
  anchorInView(id: string) {
    const el = Array.from(document.querySelectorAll<HTMLElement>('[data-vach-anchor]')).find((e) => e.getAttribute('data-vach-anchor') === id);
    if (!el) return { found: false as const };
    const rect = el.getBoundingClientRect();
    return { found: true as const, top: Math.round(rect.top), bottom: Math.round(rect.bottom), inView: rect.bottom > 0 && rect.top < window.innerHeight, innerHeight: window.innerHeight };
  },

  /** Scrolls through the whole book so every chapter has been near the screen (tables adapt, images load), then back to the top. */
  async scrollThrough() {
    const total = document.documentElement.scrollHeight;
    for (let y = 0; y <= total; y += Math.max(200, window.innerHeight / 2)) {
      window.scrollTo(0, y);
      await sleep(40);
    }
    window.scrollTo(0, 0);
    await sleep(300);
  },

  /** What the tables look like now, and the pictures. */
  contentFacts() {
    const content = document.querySelector<HTMLElement>('.reader-content')!;
    const tables = Array.from(content.querySelectorAll('table')).map((t) => ({ mode: t.getAttribute('data-vach-mode'), cols: t.rows[0]?.cells.length ?? 0, spans: t.querySelectorAll('[colspan],[rowspan]').length }));
    const images = Array.from(content.querySelectorAll('img')).map((img) => ({ width: img.getAttribute('width'), height: img.getAttribute('height'), aspect: img.style.aspectRatio, loading: img.getAttribute('loading'), natural: [img.naturalWidth, img.naturalHeight], src: (img.getAttribute('src') ?? '').slice(0, 5) }));
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    return { tables, images, overflow, title: document.querySelector('.reader-title')?.textContent ?? null, links: content.querySelectorAll('[data-vach-link]').length, anchors: content.querySelectorAll('[data-vach-anchor]').length };
  },

  /** Taps the first picture in the page. */
  async tapImage() {
    const img = document.querySelector<HTMLImageElement>('.reader-content img');
    if (!img) return false;
    img.scrollIntoView({ block: 'center' });
    await sleep(200);
    img.click();
    await sleep(500);
    return Boolean(document.querySelector('.lightbox'));
  },

  measure() {
    const rect = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
    const root = document.getElementById('root')!;
    const rs = getComputedStyle(root);
    const content = rect('.reader-content');
    const header = document.querySelector('.reader-header, .app-header');
    const firstText = (document.querySelector('.wordmark, .reader-header .icon-button') as HTMLElement | null)?.getBoundingClientRect();
    const column = rect('.library-column');
    return {
      rootPadding: [rs.paddingTop, rs.paddingRight, rs.paddingBottom, rs.paddingLeft],
      rootMaxWidth: rs.maxWidth,
      rootWidth: root.getBoundingClientRect().width,
      innerWidth: window.innerWidth,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      screenBackground: getComputedStyle(document.querySelector('.reader, .library')!).backgroundColor,
      scrollWidth: document.documentElement.scrollWidth,
      contentWidth: content?.width ?? null,
      contentLeft: content?.left ?? null,
      columnWidth: column?.width ?? null,
      firstTextTop: firstText?.top ?? null,
      headerTop: header?.getBoundingClientRect().top ?? null,
    };
  },

  /**
   * Decodes a screenshot (base64 PNG) and counts, side by side, how many pixels of the outermost 6 device pixels
   * are exactly `expected` (r,g,b). Content may legitimately cross the left/right/bottom edge (a full-width header
   * border, a list row running off the bottom), so each side reports its own share; the old frame was wrong on
   * 100% of the left, right and top edges.
   */
  async edgePixels(png: string, expected: [number, number, number], alsoAllowed: Array<[number, number, number]> = []) {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const w = img.width;
    const h = img.height;
    const ring = 6;
    const stats: Record<string, { themed: number; total: number }> = {};
    const other = new Map<string, number>();
    const count = (side: string, x: number, y: number) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      const ok = [expected, ...alsoAllowed].some((c) => d[0] === c[0] && d[1] === c[1] && d[2] === c[2]);
      const entry = (stats[side] ??= { themed: 0, total: 0 });
      entry.total++;
      if (ok) entry.themed++;
      else other.set(`${d[0]},${d[1]},${d[2]}`, (other.get(`${d[0]},${d[1]},${d[2]}`) ?? 0) + 1);
    };
    const bottomCornerWidth = Math.round(w * 0.04); // ~16 css px: where the old frame's side padding was
    for (let t = 0; t < ring; t++) {
      for (let x = 0; x < w; x++) count('top', x, t);
      for (let y = 0; y < h; y++) {
        count('left', t, y);
        count('right', w - 1 - t, y);
      }
      for (let x = 0; x < bottomCornerWidth; x++) {
        count('bottomCorners', x, h - 1 - t);
        count('bottomCorners', w - 1 - x, h - 1 - t);
      }
    }
    return { size: [w, h], stats, other: Object.fromEntries([...other].sort((a, b) => b[1] - a[1]).slice(0, 4)) };
  },
};

(globalThis as unknown as { frame: typeof api }).frame = api;
