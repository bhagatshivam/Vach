// Runs INSIDE headless Chromium (bundled by mount-measure-chromium.mjs and bounded-mounting-chromium.mjs): the frame
// harness (window.frame) plus what the mounting measurements need - timed opening, a DOM/page-height snapshot, and scripted
// flings and drags whose frame gaps are recorded. Test tooling only; nothing here ships in the app.
import './frame-entry';
import { openEpubFile } from '../../src/lib/epubFile';
import { createFileSource } from '../../src/lib/fileBridge';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Frame = {
  show(screen: 'reader', settings: object, insets: null, savedChapter?: number, fileName?: string): Promise<void>;
  screen(): { scrollY: number; scrollHeight: number; innerHeight: number; mounted: number[]; visible: Array<{ marker: string; top: number; bottom: number; text: string }>; coveredShare: number };
};
const frame = () => (globalThis as unknown as { frame: Frame }).frame;

export interface FlingStats {
  frames: number;
  distance: number;
  maxGapMs: number;
  p95GapMs: number;
  over50: number;
  over100: number;
  /** Largest page height seen while flinging. */
  maxPageHeight: number;
  /** Largest number of mounted chapters seen while flinging. */
  maxMounted: number;
  /** Where the page was when it was sampled: [scrollY, pageHeight, firstMounted, lastMounted, chapterAtTop]. */
  samples: Array<[number, number, number, number, string]>;
  /** Frames in which the page could not scroll because it had run out of mounted content below (or above) - the reader had not loaded the next chapter yet. */
  stallFrames: number;
  /** The fling gave up waiting at the edge of the mounted content (300 stalled frames): the reader did not load more. */
  stuck: boolean;
  /** The end (or start) of the book itself was reached. */
  reachedEnd: boolean;
}

const api = {
  /** Opens the reader on `fileName` and resolves with how long it took until text was on screen (ms), and when the reader finished its first reveal. */
  async openTimed(settings: object, fileName: string, savedChapter?: number) {
    const t0 = performance.now();
    let firstText = -1;
    const observer = new MutationObserver(() => {
      if (firstText >= 0) return;
      const chapter = document.querySelector('.reader-content:not(.pre-reveal) .chapter');
      if (chapter && (chapter.textContent ?? '').trim().length > 20) firstText = performance.now() - t0;
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    await frame().show('reader', settings, null, savedChapter, fileName);
    observer.disconnect();
    if (firstText < 0) firstText = performance.now() - t0;
    return { firstTextMs: Math.round(firstText), openMs: Math.round(performance.now() - t0) };
  },

  /** Waits until the reader says it has everything it is going to mount for now (streaming done, or the window filled). */
  async settle(maxMs = 120000) {
    const start = performance.now();
    let last = '';
    let stable = 0;
    while (performance.now() - start < maxMs) {
      await sleep(250);
      const s = frame().screen();
      const key = `${s.scrollHeight}|${s.mounted.join(',')}|${document.querySelector('.loading-more') ? 1 : 0}`;
      stable = key === last ? stable + 1 : 0;
      last = key;
      if (stable >= 6) break;
    }
    return performance.now() - start;
  },

  snapshot() {
    const content = document.querySelector('.reader-content');
    const s = frame().screen();
    return {
      nodes: document.getElementsByTagName('*').length,
      chapters: content ? content.querySelectorAll(':scope > .chapter').length : 0,
      pageHeight: document.documentElement.scrollHeight,
      scrollY: s.scrollY,
      mounted: s.mounted,
      images: content ? content.querySelectorAll('img').length : 0,
      blobImages: content ? Array.from(content.querySelectorAll('img')).filter((i) => (i.getAttribute('src') ?? '').startsWith('blob:')).length : 0,
      tables: content ? content.querySelectorAll('table').length : 0,
    };
  },

  /**
   * Scrolls `distance` px (negative = up) at `perFrame` px per animation frame, one scrollBy per frame - the page gets a
   * scroll event and a frame each time, like a fling does - and records how long each frame took. Calls `onSample`
   * (a name registered on window) every `sampleEvery` frames with the state at that moment.
   */
  async fling(distance: number, perFrame: number, options: { sampleEvery?: number } = {}): Promise<FlingStats> {
    const sampleEvery = options.sampleEvery ?? 50;
    const gaps: number[] = [];
    const samples: FlingStats['samples'] = [];
    let moved = 0;
    let maxPageHeight = 0;
    let maxMounted = 0;
    let last = performance.now();
    let frames = 0;
    let stallFrames = 0;
    let stuck = false;
    let reachedEnd = false;
    const step = Math.sign(distance) * perFrame;
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        gaps.push(now - last);
        last = now;
        frames++;
        const before = window.scrollY;
        window.scrollBy({ top: step, left: 0, behavior: 'instant' });
        moved += Math.abs(window.scrollY - before) || 0;
        if (frames % sampleEvery === 0) {
          const s = frame().screen();
          maxPageHeight = Math.max(maxPageHeight, s.scrollHeight);
          maxMounted = Math.max(maxMounted, s.mounted[2] ?? 0);
          samples.push([s.scrollY, s.scrollHeight, s.mounted[0] ?? -1, s.mounted[1] ?? -1, s.visible[0]?.marker ?? '?']);
        }
        if (moved >= Math.abs(distance)) return resolve();
        if (window.scrollY === before && atEdge(step)) {
          // Out of mounted content in this direction. At the real start/end of the book that is the end of the fling;
          // anywhere else the reader is expected to load more, and every frame it has not is a stall.
          const s = frame().screen();
          const first = s.mounted[0] ?? 0;
          // The reader shows "Loading more..." below the last mounted chapter until the window reaches the end of the book.
          const bookEnd = step > 0 ? !document.querySelector('.loading-more') : first <= 0;
          if (bookEnd) {
            reachedEnd = true;
            return resolve();
          }
          stallFrames++;
          if (stallFrames > 300) {
            stuck = true;
            return resolve();
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const sorted = [...gaps].sort((a, b) => a - b);
    return {
      frames,
      distance: Math.round(moved),
      maxGapMs: Math.round(Math.max(...gaps)),
      p95GapMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      over50: gaps.filter((g) => g > 50).length,
      over100: gaps.filter((g) => g > 100).length,
      maxPageHeight,
      maxMounted,
      samples,
      stallFrames,
      stuck,
      reachedEnd,
    };
  },

  /**
   * Scrolls `distance` px (negative = up) at `perFrame` px per frame and, every frame, checks that the text block that was
   * on screen last frame is where it should be: it must have moved by exactly the scroll and no more (so chapters being
   * unmounted above it, or mounted above it, never moved the text). Also counts how often the set of mounted chapters changed.
   */
  async drag(distance: number, perFrame: number) {
    const step = Math.sign(distance) * perFrame;
    const shifts: Array<{ frame: number; block: string; expected: number; actual: number }> = [];
    let frames = 0;
    let moved = 0;
    let mountChanges = 0;
    let maxChapters = 0;
    let maxNodes = 0;
    let maxPageHeight = 0;
    let range = '';
    let ref = api.visibleBlock();
    let refY = window.scrollY;
    let stall = 0;
    await new Promise<void>((resolve) => {
      const tick = () => {
        frames++;
        if (ref) {
          const now = api.blockTop(ref.id);
          if (now !== null) {
            const expected = ref.top - (window.scrollY - refY);
            if (Math.abs(now - expected) > 1.5) shifts.push({ frame: frames, block: ref.id, expected: Math.round(expected * 10) / 10, actual: now });
          }
        }
        const s = frame().screen();
        const key = `${s.mounted[0]}-${s.mounted[1]}`;
        if (key !== range) {
          if (range) mountChanges++;
          range = key;
        }
        maxChapters = Math.max(maxChapters, s.mounted[2] ?? 0);
        maxPageHeight = Math.max(maxPageHeight, s.scrollHeight);
        if (frames % 40 === 0) maxNodes = Math.max(maxNodes, document.getElementsByTagName('*').length);
        if (moved >= Math.abs(distance)) return resolve();
        const before = window.scrollY;
        window.scrollBy({ top: step, left: 0, behavior: 'instant' });
        const delta = Math.abs(window.scrollY - before);
        moved += delta;
        stall = delta === 0 ? stall + 1 : 0;
        if (stall > 200) return resolve();
        ref = api.visibleBlock();
        refY = window.scrollY;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return { frames, moved: Math.round(moved), shifts, mountChanges, maxChapters, maxNodes, maxPageHeight, stalled: stall > 200, atBookEnd: !document.querySelector('.loading-more') };
  },

  /**
   * Watches the page for `ms` while something else (a real touch gesture, driven by the browser's compositor) scrolls it: every
   * frame, the text block that was on screen the frame before must be where the scroll says it should be. Same check as drag(),
   * but nothing here scrolls - this is what a finger's fling does.
   */
  async watch(ms: number) {
    const shifts: Array<{ frame: number; block: string; expected: number; actual: number }> = [];
    const gaps: number[] = [];
    let frames = 0;
    let mountChanges = 0;
    let range = '';
    let last = performance.now();
    const from = Number(api.visibleBlock()?.id.split(':')[0] ?? -1);
    let ref = api.visibleBlock();
    let refY = window.scrollY;
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        frames++;
        gaps.push(now - last);
        last = now;
        if (ref) {
          const actual = api.blockTop(ref.id);
          if (actual !== null) {
            const expected = ref.top - (window.scrollY - refY);
            if (Math.abs(actual - expected) > 1.5) shifts.push({ frame: frames, block: ref.id, expected: Math.round(expected * 10) / 10, actual });
          }
        }
        const s = frame().screen();
        const key = `${s.mounted[0]}-${s.mounted[1]}`;
        if (key !== range) {
          if (range) mountChanges++;
          range = key;
        }
        ref = api.visibleBlock();
        refY = window.scrollY;
        if (performance.now() - t0 >= ms) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const sorted = [...gaps].sort((a, b) => a - b);
    return { frames, shifts, mountChanges, from, to: Number(api.visibleBlock()?.id.split(':')[0] ?? -1), maxGapMs: Math.round(Math.max(...gaps)), p95GapMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0), over50: gaps.filter((g) => g > 50).length };
  },

  /**
   * Taps the Contents entry titled `title` (the drawer must already be open) and times how long it takes until chapter
   * (page) `target` is on screen with the reader revealed; also reports whether the "Getting to ..." wait bar was ever up.
   * A page counts as on screen when its text carries MARK_<target>, or, for a scanned page, when #pdf-page-<target + 1> is in view.
   */
  async timedJump(title: string, target: number, timeoutMs = 120000) {
    const entry = Array.from(document.querySelectorAll<HTMLButtonElement>('.toc-item')).find((b) => b.textContent === title);
    if (!entry) return { error: `no Contents entry "${title}"` };
    entry.scrollIntoView({ block: 'center' });
    const t0 = performance.now();
    entry.click();
    let waitBar = false;
    let barSince = -1;
    let barMs = 0;
    let overlaySeen = false;
    while (performance.now() - t0 < timeoutMs) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const bar = Boolean(document.querySelector('.toc-wait'));
      if (bar && barSince < 0) barSince = performance.now();
      if (!bar && barSince >= 0) {
        barMs += performance.now() - barSince;
        barSince = -1;
      }
      waitBar ||= bar;
      overlaySeen ||= Boolean(document.querySelector('.restore-overlay'));
      const revealed = !document.querySelector('.restore-overlay') && Boolean(document.querySelector('.reader-content:not(.pre-reveal)')) && !document.querySelector('.toc-panel');
      if (!revealed) continue;
      const onScreen = frame().screen().visible.some((v) => v.marker === String(target));
      const figure = document.getElementById(`pdf-page-${target + 1}`);
      const figureRect = figure?.getBoundingClientRect();
      const figureOnScreen = Boolean(figureRect && figureRect.bottom > 0 && figureRect.top < window.innerHeight);
      if (onScreen || figureOnScreen) return { ms: Math.round(performance.now() - t0), waitBar, waitBarMs: Math.round(barMs), overlaySeen };
    }
    return { error: 'timed out', ms: Math.round(performance.now() - t0), waitBar };
  },

  /** How long the part of opening an EPUB that a metadata cache could skip takes: reading and parsing its index, then its table of contents. */
  async timeEpubIndex(name: string) {
    const bridge = (window as unknown as { __bridge: { calls: number; bytes: number } }).__bridge;
    const calls0 = bridge.calls;
    const bytes0 = bridge.bytes;
    const t0 = performance.now();
    const book = await openEpubFile(`content://x/${name}`, name);
    const t1 = performance.now();
    const toc = await book.toc();
    const t2 = performance.now();
    book.close();
    return { openMs: Math.round(t1 - t0), tocMs: Math.round(t2 - t1), chapters: book.chapterCount, tocItems: toc.length, calls: bridge.calls - calls0, bytes: bridge.bytes - bytes0 };
  },

  /** The same for a PDF: opening the document (pdf.js reads the cross-reference table and the page tree), then resolving its outline. */
  async timeOpenPdf(name: string) {
    const bridge = (window as unknown as { __bridge: { calls: number; bytes: number } }).__bridge;
    const calls0 = bridge.calls;
    const bytes0 = bridge.bytes;
    const { openPdf } = await import('../../src/lib/pdf');
    const t0 = performance.now();
    const source = await createFileSource(`content://x/${name}`);
    const handle = await openPdf(source, name);
    const t1 = performance.now();
    const outline = await handle.getOutline();
    const t2 = performance.now();
    const pages = handle.numPages;
    handle.destroy();
    return { openMs: Math.round(t1 - t0), outlineMs: Math.round(t2 - t1), pages, outlineItems: outline.length, calls: bridge.calls - calls0, bytes: bridge.bytes - bytes0 };
  },

  /** Opens the Contents drawer, expands every group, and returns the entries' titles (the drawer is left open for frame.jumpTo). Null if the book has no Contents. */
  async tocTitles(): Promise<string[] | null> {
    if (!(await (globalThis as unknown as { frame: { openToc(): Promise<boolean> } }).frame.openToc())) return null;
    document.querySelectorAll<HTMLButtonElement>('.toc-toggle[aria-expanded="false"]').forEach((b) => b.click());
    await sleep(150);
    return Array.from(document.querySelectorAll('.toc-item')).map((b) => b.textContent ?? '');
  },

  /** Where the chapter with this marker currently is: its top relative to the viewport (null if it is not mounted). */
  chapterTop(marker: string): number | null {
    const el = Array.from(document.querySelectorAll<HTMLElement>('.reader-content > .chapter')).find((c) => new RegExp(`MARK_${marker}\\b`).test(c.textContent ?? ''));
    return el ? Math.round(el.getBoundingClientRect().top * 10) / 10 : null;
  },

  /** The first text block that is on screen, with its position: used to prove nothing moved when chapters were unmounted. */
  visibleBlock(): { id: string; top: number } | null {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('.reader-content p, .reader-content h2, .reader-content h3'));
    for (const el of blocks) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > 4 && rect.top < window.innerHeight - 4) {
        const chapter = el.closest('.chapter');
        const mark = /MARK_(\d+)/.exec(chapter?.textContent ?? '')?.[1] ?? '?';
        const index = Array.from(chapter?.children ?? []).indexOf(el);
        return { id: `${mark}:${index}`, top: Math.round(rect.top * 10) / 10 };
      }
    }
    return null;
  },

  /** The block with this id (chapter:child index) if it is mounted, with its top. */
  blockTop(id: string): number | null {
    const [mark, index] = id.split(':');
    const chapter = Array.from(document.querySelectorAll<HTMLElement>('.reader-content > .chapter')).find((c) => new RegExp(`MARK_${mark}\\b`).test(c.textContent ?? ''));
    const el = chapter?.children[Number(index)] as HTMLElement | undefined;
    return el ? Math.round(el.getBoundingClientRect().top * 10) / 10 : null;
  },
};

function atEdge(step: number): boolean {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return step > 0 ? window.scrollY >= max - 1 : window.scrollY <= 1;
}

(globalThis as unknown as { mm: typeof api }).mm = api;
