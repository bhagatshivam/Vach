// Runs INSIDE headless Chromium (bundled by tables-chromium.mjs): builds the
// reader's real DOM and CSS (src/App.css) from a real EPUB through the real
// sanitizer, runs the real table adapter, and measures real layout.
import '../../src/index.css';
import '../../src/App.css';
import JSZip from 'jszip';
import { archiveFromJSZip, openEpub } from '../../src/lib/epub';
import { anchorScrollTarget, needsScroll, preserveAnchorDuring } from '../../src/lib/reanchor';
import { computeAnchor, flattenToLeafBlocks } from '../../src/lib/readerAnchor';
import { lightboxIsOpen, mountLightbox, sleep, unmountLightbox, view, drag, pinchGesture, stage } from './lightboxDriver';
import { TableAdaptController, cloneForGrid, topLevelTables, currentMode } from '../../src/lib/tableAdapter';

const toBytes = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

let controller: TableAdaptController | null = null;
let content: HTMLElement | null = null;

const chapters = (): HTMLElement[] => Array.from(content!.querySelectorAll(':scope > .chapter'));

function overflow() {
  const box = content!.getBoundingClientRect();
  let worst = { amount: 0, tag: '', text: '' };
  for (const el of Array.from(content!.querySelectorAll('*'))) {
    if (el.closest('table.vach-table-collapsed')) continue; // clipped to zero height, takes no room
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const amount = Math.max(rect.right - box.right, box.left - rect.left);
    if (amount > worst.amount) worst = { amount: Math.round(amount * 10) / 10, tag: el.tagName.toLowerCase(), text: (el.textContent ?? '').slice(0, 40) };
  }
  // With overflow-x: clip, scrollWidth would hide an overflow behind the guard, so look with the guard off.
  const previous = content!.style.overflowX;
  content!.style.overflowX = 'visible';
  const scrollWidth = content!.scrollWidth;
  const clientWidth = content!.clientWidth;
  const pageScrollWidth = document.documentElement.scrollWidth;
  content!.style.overflowX = previous;
  return {
    scrollWidth,
    clientWidth,
    pageScrollWidth,
    innerWidth: window.innerWidth,
    worstElementOverflow: worst,
    ok: scrollWidth <= clientWidth && pageScrollWidth <= window.innerWidth && worst.amount <= 0.5,
  };
}

const api: Record<string, any> = {
  async load(base64: string, { adapt }: { adapt: boolean }) {
    controller?.destroy();
    document.body.innerHTML = '';
    const book = await openEpub(archiveFromJSZip(await JSZip.loadAsync(toBytes(base64))), 'sample');
    const reader = document.createElement('div');
    reader.className = 'reader';
    reader.dataset.theme = 'sepia';
    reader.style.cssText = 'background:#f4ecd8;color:#3b2f1e';
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
    controller = new TableAdaptController({
      // The same view-keeping the reader uses for passes triggered by scrolling.
      preserveView: (work) => preserveAnchorDuring(chapters, work),
      // The real lightbox (the same component the reader uses), showing a copy of the table.
      onExpand: (table) => {
        void mountLightbox({ label: 'Table', node: cloneForGrid(table) });
      },
    });
    if (adapt) for (const section of chapters()) controller.register(section);
    if (adapt) await api.adaptAll();
    return { chapters: book.chapterCount, tables: topLevelTables(content).length };
  },

  async reevaluate() {
    await controller!.reevaluate({ preserveView: false });
    await api.adaptAll();
  },

  /** Scroll through the whole book so every chapter comes near the viewport (what reading does), then back. */
  async adaptAll() {
    const frames = (n: number) => new Promise<void>((resolve) => { const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1))); step(n); });
    const total = document.documentElement.scrollHeight;
    for (let y = 0; y <= total; y += Math.max(200, window.innerHeight / 2)) {
      window.scrollTo(0, y);
      await frames(2);
      await controller!.reevaluate({ preserveView: false });
    }
    window.scrollTo(0, 0);
    await frames(2);
    await controller!.reevaluate({ preserveView: false });
  },

  setFontSize(px: number) {
    content!.style.fontSize = `${px}px`;
  },

  overflow,

  modes() {
    return topLevelTables(content!).map((table) => ({
      mode: currentMode(table),
      columns: table.rows[0]?.cells.length ?? 0,
      first: (table.rows[0]?.textContent ?? '').trim().slice(0, 30),
    }));
  },

  /** The block-structure of every chapter: must not change however the tables are shown. */
  blockCounts() {
    return chapters().map((chapter) => flattenToLeafBlocks(chapter).length);
  },

  /** Plant something 2,000px wide to prove the checker would notice an overflow. */
  plantOverflow() {
    const bad = document.createElement('div');
    bad.style.cssText = 'width: 2000px; height: 10px; background: red';
    chapters()[0].append(bad);
    return () => bad.remove();
  },

  /** Click the first Expand Grid button; report how the opened grid behaves in the real lightbox. */
  async openGrid() {
    const button = content!.querySelector<HTMLButtonElement>('.vach-table-expand');
    if (!button) return null;
    button.click();
    await sleep(120);
    const table = document.querySelector<HTMLElement>('.lightbox-content table') as HTMLTableElement | null;
    if (!table) return null;
    const opened = view();
    const vw = opened.viewport.width;
    const vh = opened.viewport.height;
    // A wide table opens at its own size: wider than the screen, so it can be panned and pinched.
    await drag([vw * 0.8, vh / 2], [vw * 0.2, vh / 2]);
    const panned = view();
    await pinchGesture(vw / 2, vh / 2, 60, 180);
    const zoomed = view();
    return {
      widerThanScreen: opened.rect.width > vw + 1,
      startsAtLeftEdge: Math.abs(opened.rect.left) <= 1,
      panMoves: Math.abs(panned.x - opened.x) > 20,
      panClamped: panned.rect.right >= vw - 0.5,
      pinchZooms: zoomed.scale > opened.scale * 1.5,
      tableClasses: table.className,
      hasLabels: table.querySelector('[data-label]') !== null,
      columns: table.rows[0].cells.length,
      open: lightboxIsOpen(),
    };
  },

  closeGrid() {
    unmountLightbox();
  },

  stageExists: () => Boolean(stage()),

  /** Scroll to a paragraph, change the layout, restore from the captured anchor: is the same text at the top? */
  async reanchorCheck(chapterIndex: number, newFontSizePx: number) {
    const target = chapters()[chapterIndex].querySelectorAll('p')[1] ?? chapters()[chapterIndex].querySelector('p')!;
    window.scrollTo(0, window.scrollY + target.getBoundingClientRect().top - 20);
    const before = computeAnchor(chapters(), 0)!;
    const textBefore = flattenToLeafBlocks(chapters()[before.chapterIndex])[before.blockIndex].textContent!.slice(0, 40);

    content!.style.fontSize = `${newFontSizePx}px`;
    await controller!.reevaluate({ preserveView: false });
    const y = anchorScrollTarget(chapters(), before, 0, window.scrollY);
    if (y !== null && needsScroll(window.scrollY, y)) window.scrollTo(0, y);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const after = computeAnchor(chapters(), 0)!;
    const textAfter = flattenToLeafBlocks(chapters()[after.chapterIndex])[after.blockIndex].textContent!.slice(0, 40);
    return { before, after, textBefore, textAfter, sameBlock: before.chapterIndex === after.chapterIndex && before.blockIndex === after.blockIndex };
  },
};

(globalThis as unknown as { verify: typeof api }).verify = api;
