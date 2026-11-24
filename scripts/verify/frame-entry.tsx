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

let root: Root | null = null;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const api = {
  async show(screen: 'library-empty' | 'library-books' | 'reader', settings: object, insets: { top: number; bottom: number; left: number; right: number } | null) {
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
    (window as unknown as { __libraryMode: string }).__libraryMode = screen === 'library-books' ? 'books' : 'empty';
    root = createRoot(document.getElementById('root')!);
    const ref = createRef<(() => void) | null>() as { current: (() => void) | null };
    if (screen === 'reader') {
      root.render(<ReaderScreen file={{ name: 'sample.epub', uri: 'content://x/sample.epub', path: 'sample.epub', size: 1 }} onBack={() => {}} />);
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
