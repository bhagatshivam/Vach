// Runs INSIDE headless Chromium (bundled by docx-chromium.mjs as a normal app page, so the Worker is emitted as its own
// file exactly as in the real build): drives the real Word converter through the real worker client.
import { convertDocxBytes } from '../../src/lib/docxClient';
import { openDocx } from '../../src/lib/docx';

const toBytes = (base64: string): ArrayBuffer => {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

let workersStarted = 0;
const RealWorker = window.Worker;
window.Worker = class extends RealWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    workersStarted++;
  }
} as typeof Worker;

let fellBack = false;
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  if (String(args[0]).includes('worker unavailable')) fellBack = true;
  warn(...args);
};

const longTasks: number[] = [];
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) longTasks.push(entry.duration);
}).observe({ entryTypes: ['longtask'] });

(window as unknown as { docx: unknown }).docx = {
  /** Converts through the worker client and reports where it ran and how long the main thread was blocked. */
  async convert(source: string) {
    // `source` is a URL on the test origin (the file is served as binary, so no base64 copy inflates memory)
    // or, for the small error cases, base64 text.
    const buffer = source.startsWith('/') ? await (await fetch(source)).arrayBuffer() : toBytes(source);
    longTasks.length = 0;
    workersStarted = 0;
    fellBack = false;
    // How long the page was unresponsive: the largest gap between animation frames while everything runs.
    let maxFrameGap = 0;
    let last = performance.now();
    let running = true;
    const tick = () => {
      const now = performance.now();
      maxFrameGap = Math.max(maxFrameGap, now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    const result = await convertDocxBytes(buffer);
    const convertMs = performance.now() - t0;
    const blockedDuringConvert = [...longTasks];

    // The main-thread part: slicing and the book's first chapter (sanitizer, image registration).
    longTasks.length = 0;
    const t1 = performance.now();
    const book = await openDocx(buffer, 'Doc', { convert: async () => result });
    const sliceMs = performance.now() - t1;
    const t2 = performance.now();
    const first = await book.loadChapter(0);
    const firstChapterMs = performance.now() - t2;
    // Every section, one after another (what streaming the book in does): total and the slowest single one.
    let allChaptersMs = 0;
    let slowestChapterMs = 0;
    for (let i = 0; i < book.chapterCount; i++) {
      const t = performance.now();
      await book.loadChapter(i);
      const took = performance.now() - t;
      allChaptersMs += took;
      slowestChapterMs = Math.max(slowestChapterMs, took);
    }
    const toc = await book.toc();
    running = false;
    return {
      largestFrameGapMs: Math.round(maxFrameGap),
      ranInWorker: workersStarted > 0 && !fellBack,
      fellBack,
      convertMs: Math.round(convertMs),
      longestBlockDuringConvertMs: Math.round(Math.max(0, ...blockedDuringConvert)),
      longTasksDuringConvert: blockedDuringConvert.length,
      sliceMs: Math.round(sliceMs),
      firstChapterMs: Math.round(firstChapterMs),
      allChaptersMs: Math.round(allChaptersMs),
      slowestChapterMs: Math.round(slowestChapterMs),
      imageStoreUrls: book.images.liveUrlCount,
      longestBlockMainThreadWorkMs: Math.round(Math.max(0, ...longTasks)),
      htmlBytes: result.html.length,
      images: result.images.length,
      imageBytes: result.images.reduce((n, i) => n + i.bytes.length, 0),
      title: result.title,
      chapters: book.chapterCount,
      tocEntries: toc.length,
      firstChapterLength: first.length,
      warnings: result.warnings,
      heapMB: Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6),
    };
  },
  /** An invalid document: which error comes back. */
  async error(base64: string) {
    try {
      await convertDocxBytes(toBytes(base64));
      return { ok: true };
    } catch (err) {
      return { ok: false, name: (err as Error).name, code: (err as { code?: string }).code, message: (err as Error).message };
    }
  },
};
