#!/usr/bin/env node
// Bounded chapter mounting in headless Chromium: the REAL ReaderScreen, CSS, sanitizer, table and image controllers,
// Contents drawer (fake file bridge, phone-sized viewport, throttled CPU). Scrolls a 10.7M px book from top to bottom and
// back, in fast flings and slow drags, and checks:
//   - what is PAINTED (pixels, not the DOM) at many points: Chromium paints nothing past 2^23 px of scroll offset
//   - the page never gets taller than the cap (1.5M px), and the number of mounted chapters and DOM nodes stays flat
//   - the text on screen never shifts when chapters are unmounted or mounted above it
//   - JS heap stays flat and a chapter's blob: URLs are released when it unmounts
//   - a chapter that is unmounted and mounted again comes back with its pictures sized and its table adapted
//   - the lightbox keeps what it shows, font size changes and a reopen mid-book keep the place
//
//   node scripts/verify/bounded-mounting-chromium.mjs            (ONLY=tall,drag,images,... to pick)
//
// CPU_SLOWDOWN (default 4) throttles the CPU like a mid-range phone.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(join(repo, 'package.json'));

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.log('SKIPPED: Playwright is not installed here, so there is no headless Chromium to check against.');
  process.exit(0);
}
const { epub, tallEpub, LOREM } = await import('./syntheticBooks.mjs');

const only = (process.env.ONLY ?? 'tall,drag,gesture,images,lightbox,font,reopen,docx').split(',');
const CPU = Number(process.env.CPU_SLOWDOWN ?? 4);
const MAX_MOUNTED_PX = 1_500_000;

const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
const outDir = join(repo, 'node_modules/.cache/vach-bench/verify-bounded');
const stub = (pattern, file) => ({ name: `stub-${file}`, enforce: 'pre', resolveId: (source) => (pattern.test(source) ? join(here, file) : null) });
await build({
  root: repo,
  configFile: false,
  logLevel: 'warn',
  plugins: [stub(/(^|\/)epubFile(\.ts)?$/, 'epubFileStub.ts'), stub(/(^|\/)docxFile(\.ts)?$/, 'docxFileStub.ts'), stub(/(^|\/)libraryFolder(\.ts)?$/, 'libraryFolderStub.ts'), stub(/(^|\/)pdf(\.ts)?$/, 'pdfStub.ts'), react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: { outDir, emptyOutDir: true, minify: false, cssCodeSplit: false, lib: { entry: join(here, 'measure-entry.tsx'), name: 'vachMeasure', formats: ['iife'], fileName: () => 'measure-entry.js' } },
});
const script = readFileSync(join(outDir, 'measure-entry.js'), 'utf8');
const css = readdirSync(outDir).filter((n) => n.endsWith('.css')).map((n) => readFileSync(join(outDir, n), 'utf8')).join('\n');

const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const VIEWPORT = { width: 360, height: 800 };
const BG = [244, 236, 216];

async function openPage(globals, viewport = VIEWPORT) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('http://vach.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"></head><body><div id="root"></div></body></html>' }));
  await page.goto('http://vach.test/');
  await page.addStyleTag({ content: css });
  if (process.env.EXTRA_CSS) await page.addStyleTag({ content: process.env.EXTRA_CSS });
  await page.evaluate((g) => Object.assign(window, { __sampleEpub: '', __sampleDocx: '' }, g), globals);
  await page.addScriptTag({ content: script });
  return { page, cdp, errors };
}

async function heapMB(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return Math.round((usedSize / 1048576) * 10) / 10;
}

async function ink(page) {
  const shot = await page.screenshot({ type: 'png' });
  return page.evaluate(async ([png, bg]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40) n++;
    return n / (d.length / 4);
  }, [shot.toString('base64'), BG]);
}

const open = (page, file, saved) => page.evaluate(([f, s]) => window.mm.openTimed({ theme: 'sepia' }, f, s ?? undefined), [file, saved ?? null]);
const wait = (page, ms) => page.waitForTimeout(ms);

/** Flings through the whole book in chunks, checking the painted screen after each; returns what it saw. */
async function traverse(page, { perFrame, direction, chunk = 150000, label }) {
  const inks = [];
  let maxHeight = 0;
  let maxChapters = 0;
  let stalls = 0;
  let stuck = false;
  let travelled = 0;
  let reachedEnd = false;
  const started = Date.now();
  for (let i = 0; i < 600 && !reachedEnd; i++) {
    const stats = await page.evaluate(([d, p]) => window.mm.fling(d, p, { sampleEvery: 25 }), [direction * chunk, perFrame]);
    travelled += stats.distance;
    maxHeight = Math.max(maxHeight, stats.maxPageHeight);
    maxChapters = Math.max(maxChapters, stats.maxMounted);
    stalls += stats.stallFrames;
    stuck ||= stats.stuck;
    reachedEnd = stats.reachedEnd || stats.stuck;
    await wait(page, 120);
    inks.push(await ink(page));
    if (Date.now() - started > 15 * 60 * 1000) break;
  }
  const blank = inks.filter((v) => v < 0.002).length;
  console.log(`  ${label}: ${(travelled / 1e6).toFixed(2)}M px in ${Math.round((Date.now() - started) / 1000)}s, ${inks.length} screens checked, page height at most ${(maxHeight / 1e6).toFixed(2)}M px, at most ${maxChapters} chapters mounted, ${stalls} stalled frames`);
  return { inks, blank, maxHeight, maxChapters, stalls, stuck, reachedEnd, travelled };
}

// ---- 1. the 10.7M px book, top to bottom and back, in fast flings --------------------------------------------------------------
if (only.includes('tall')) {
  const { page, cdp, errors } = await openPage({ __sampleEpub: await tallEpub() });
  const opened = await open(page, 'tall.epub');
  await wait(page, 800);
  const startSnap = await page.evaluate(() => window.mm.snapshot());
  const heapStart = await heapMB(cdp);
  record(`tall book: opens with a short page, not the whole book (${startSnap.chapters} chapters, ${(startSnap.pageHeight / 1e6).toFixed(2)}M px, text after ${opened.firstTextMs} ms)`, startSnap.pageHeight < MAX_MOUNTED_PX && startSnap.chapters < 20);

  const down = await traverse(page, { perFrame: 800, direction: 1, label: 'fling down (800 px per frame, about 6x a hard swipe)' });
  record('tall book: fling from the top to the very end reaches the last chapter', down.reachedEnd && !down.stuck, `${(down.travelled / 1e6).toFixed(2)}M px`);
  record('tall book: no blank screen anywhere on the way down (painted pixels)', down.blank === 0, `${down.blank}/${down.inks.length} blank`);
  record(`tall book: the page never got taller than ${MAX_MOUNTED_PX.toLocaleString('en-US')} px going down`, down.maxHeight <= MAX_MOUNTED_PX, `${down.maxHeight.toLocaleString('en-US')} px`);
  record('tall book: the reader never ran out of mounted content mid-book going down (no stalled frames)', down.stalls === 0, `${down.stalls} stalled frames`);
  const heapEnd = await heapMB(cdp);
  const text = await page.evaluate(() => window.frame.screen().visible.map((v) => v.marker));
  record('tall book: the very end of the book is the last chapter, painted', text.includes('149') && (await ink(page)) > 0.002, `on screen: ${text.join(',')}`);

  const up = await traverse(page, { perFrame: 800, direction: -1, label: 'fling up (800 px per frame)' });
  record('tall book: fling from the very end back to the top reaches the first chapter', up.reachedEnd && !up.stuck);
  record('tall book: no blank screen anywhere on the way back up', up.blank === 0, `${up.blank}/${up.inks.length} blank`);
  record(`tall book: the page never got taller than the cap going back up`, up.maxHeight <= MAX_MOUNTED_PX, `${up.maxHeight.toLocaleString('en-US')} px`);
  record('tall book: no stalled frames going back up', up.stalls === 0, `${up.stalls} stalled frames`);
  const heapBack = await heapMB(cdp);
  record(`tall book: JS heap stays flat across 21M px of scrolling (${heapStart} -> ${heapEnd} -> ${heapBack} MB)`, heapBack < heapStart * 2 + 4);
  record('tall book: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- 2. slow drags across many chapter boundaries: the text on screen never moves -------------------------------------------------
if (only.includes('drag')) {
  // 240 chapters of ~1.4k px: a window is a handful of chapters, so a drag unmounts and mounts chapters all the time.
  const book = await epub(Array.from({ length: 240 }, (_, i) => ({ title: `Chapter ${i + 1}`, paragraphs: 3 + (i % 4), text: LOREM.repeat(2) })), { title: 'Drag book' });
  const { page, errors } = await openPage({ __sampleEpub: book });
  await open(page, 'drag.epub');
  await wait(page, 600);
  const startSnap = await page.evaluate(() => window.mm.snapshot());
  const down = await page.evaluate(() => window.mm.drag(150000, 30));
  record(`slow drag down 150,000 px (${down.frames} frames): the text on screen never moved when chapters were mounted or unmounted`, down.shifts.length === 0, down.shifts.slice(0, 3).map((s) => `frame ${s.frame}: ${s.block} expected ${s.expected} got ${s.actual}`).join('; '));
  record(`slow drag down: the set of mounted chapters changed ${down.mountChanges} times (so the check above exercised unmounting and mounting)`, down.mountChanges >= 20);
  record(`slow drag down: at most ${down.maxChapters} chapters, ${down.maxNodes} DOM nodes and ${(down.maxPageHeight / 1e3).toFixed(0)}k px mounted (it started with ${startSnap.chapters} chapters, ${startSnap.nodes} nodes)`, down.maxPageHeight < MAX_MOUNTED_PX && down.maxNodes < startSnap.nodes * 4 + 200);
  const up = await page.evaluate(() => window.mm.drag(-120000, 30));
  record(`slow drag back up 120,000 px (${up.frames} frames): the text on screen never moved`, up.shifts.length === 0, up.shifts.slice(0, 3).map((s) => `frame ${s.frame}: ${s.block} expected ${s.expected} got ${s.actual}`).join('; '));
  record(`slow drag back up: chapters were mounted above the reader as it went (${up.mountChanges} changes)`, up.mountChanges >= 15);
  // A hard fling over the same book, then back.
  const fastDown = await page.evaluate(() => window.mm.drag(400000, 400));
  // (It may run into the end of the book, where the page cannot scroll any further: that is not a stall.)
  record(`fast drag (400 px per frame, ${fastDown.frames} frames, ${(fastDown.moved / 1e3).toFixed(0)}k px) over the same book: the text on screen never moved either, and the reader never ran out of chapters before the end of the book`, fastDown.shifts.length === 0 && (!fastDown.stalled || fastDown.atBookEnd), fastDown.shifts.slice(0, 3).map((s) => `frame ${s.frame}: ${s.block} expected ${s.expected} got ${s.actual}`).join('; '));
  record('drags: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- 2b. a real touch fling, scrolled by the browser's compositor, not by script ---------------------------------------------------
if (only.includes('gesture')) {
  const book = await epub(Array.from({ length: 400 }, (_, i) => ({ title: `Chapter ${i + 1}`, paragraphs: 3 + (i % 4), text: LOREM.repeat(2) })), { title: 'Gesture book' });
  const { page, cdp, errors } = await openPage({ __sampleEpub: book });
  await open(page, 'gesture.epub');
  await wait(page, 600);
  const fling = async (distance, speed, ms) => {
    const watching = page.evaluate((t) => window.mm.watch(t), ms);
    await cdp.send('Input.synthesizeScrollGesture', { x: 180, y: 600, yDistance: -distance, speed });
    return watching;
  };
  let allShifts = 0;
  let totalScrolled = 0;
  let totalChanges = 0;
  let worstGap = 0;
  for (let i = 0; i < 6; i++) {
    const down = await fling(24000, 8000, 5000);
    allShifts += down.shifts.length;
    console.log(`  fling down: chapter ${down.from} -> ${down.to}, ${down.frames} frames, ${down.mountChanges} mount changes, worst gap ${down.maxGapMs} ms`);
    totalScrolled += Math.abs(down.to - down.from);
    totalChanges += down.mountChanges;
    worstGap = Math.max(worstGap, down.maxGapMs);
    if (down.shifts.length) console.log('  shifts', JSON.stringify(down.shifts.slice(0, 3)));
  }
  for (let i = 0; i < 4; i++) {
    const up = await page.evaluate(() => 0).then(() => fling(-24000, 8000, 5000));
    allShifts += up.shifts.length;
    console.log(`  fling up: chapter ${up.from} -> ${up.to}, ${up.frames} frames, ${up.mountChanges} mount changes, worst gap ${up.maxGapMs} ms`);
    totalScrolled += Math.abs(up.to - up.from);
    totalChanges += up.mountChanges;
    worstGap = Math.max(worstGap, up.maxGapMs);
    if (up.shifts.length) console.log('  shifts', JSON.stringify(up.shifts.slice(0, 3)));
  }
  record(`compositor fling: ten 24,000 px flings at 8,000 px/s (${totalScrolled} chapters travelled, scrolled by the compositor, ${totalChanges} changes to the mounted chapters): the text on screen never moved when chapters were unmounted or mounted`, allShifts === 0 && totalChanges >= 10, `${allShifts} shifts, worst frame gap ${worstGap} ms`);
  record('compositor fling: the screen is painted afterwards', (await ink(page)) > 0.002);
  record('compositor fling: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- 3. chapters with pictures and a table, unmounted and mounted again ------------------------------------------------------------
if (only.includes('images')) {
  const book = await epub(Array.from({ length: 120 }, (_, i) => ({ title: `Chapter ${i + 1}`, paragraphs: 5, text: LOREM.repeat(2), image: i % 2 ? 'a' : 'b', table: i % 3 === 0 })), { title: 'Pictures and tables' });
  const { page, cdp, errors } = await openPage({ __sampleEpub: book });
  await open(page, 'pictures.epub');
  await wait(page, 800);
  const urls = () => page.evaluate(() => window.__book?.images.liveUrlCount ?? -1);
  const heights = new Map();
  // Reading down: note how tall each chapter is once it has settled (pictures laid out, tables adapted).
  let peakUrls = 0;
  let peakImages = 0;
  for (let i = 0; i < 60; i++) {
    await page.evaluate(() => window.mm.fling(2600, 100));
    await wait(page, 250);
    const settled = await page.evaluate(() => Array.from(document.querySelectorAll('.reader-content > .chapter')).map((c) => [/MARK_(\d+)/.exec(c.textContent ?? '')?.[1], Math.round(c.getBoundingClientRect().height), c.querySelectorAll('table[data-vach-mode]').length, c.querySelectorAll('table').length, c.getBoundingClientRect().top]));
    for (const [marker, height, adapted, tables, top] of settled) if (top > -600 && top < 600 && (adapted === tables)) heights.set(marker, height);
    peakUrls = Math.max(peakUrls, await urls());
    const snap = await page.evaluate(() => window.mm.snapshot());
    peakImages = Math.max(peakImages, snap.images);
  }
  const atEnd = await page.evaluate(() => window.frame.screen());
  const liveAfter = await urls();
  record(`pictures: after reading ${atEnd.mounted[1]} chapters down the book only the window's pictures are alive (${liveAfter} blob URLs; at most ${peakImages} <img> mounted)`, liveAfter >= 0 && liveAfter <= 24, `peak ${peakUrls}`);
  // And back up to the start: the chapters come back, with their pictures sized before they load and their tables adapted again.
  await page.evaluate(() => window.scrollTo(0, 0));
  const upStats = await page.evaluate(() => window.mm.fling(-60 * 2600 - 400000, 400));
  await wait(page, 800);
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(page, 800);
  const back = await page.evaluate(() => window.frame.screen());
  record(`pictures: scrolling back to the top mounts the first chapters again (${back.mounted[0]}..${back.mounted[1]})`, back.mounted[0] === 0, JSON.stringify(upStats.reachedEnd));
  const remounted = await page.evaluate(() => {
    const chapters = Array.from(document.querySelectorAll('.reader-content > .chapter')).filter((c) => c.querySelector('img'));
    return chapters.map((c) => ({
      marker: /MARK_(\d+)/.exec(c.textContent ?? '')?.[1],
      height: Math.round(c.getBoundingClientRect().height),
      imgs: Array.from(c.querySelectorAll('img')).map((i) => ({ aspect: i.style.aspectRatio, w: i.getAttribute('width'), h: i.getAttribute('height') })),
      tables: Array.from(c.querySelectorAll('table')).map((t) => t.getAttribute('data-vach-mode')),
    }));
  });
  record('pictures: every picture in a remounted chapter is sized before it loads (aspect ratio and size stamped again)', remounted.length > 0 && remounted.every((c) => c.imgs.every((i) => i.aspect || (i.w && i.h))), JSON.stringify(remounted[0]));
  const withTable = remounted.filter((c) => c.tables.length > 0);
  record('pictures: every table in a remounted chapter is adapted again', withTable.length > 0 && withTable.every((c) => c.tables.every((t) => t !== null)), `${withTable.length} chapters with tables: ${JSON.stringify(withTable[0]?.tables)}`);
  // The same chapter is the same height now as when it was first read: nothing jumps when it comes back.
  const same = remounted.filter((c) => heights.has(c.marker));
  const drift = same.map((c) => Math.abs(c.height - heights.get(c.marker)));
  record(`pictures: a chapter that comes back is as tall as when it was first read, so no layout jump (${same.length} compared, worst difference ${Math.max(0, ...drift)} px)`, same.length > 0 && Math.max(...drift) <= 2);
  record('pictures: no uncaught page errors', errors.length === 0, errors.join('; '));
  record('pictures: JS heap after all that is small', (await heapMB(cdp)) < 60);
  await page.close();
}

// ---- 4. the lightbox pins what it shows ----------------------------------------------------------------------------------------------
if (only.includes('lightbox')) {
  const book = await epub(Array.from({ length: 80 }, (_, i) => ({ title: `Chapter ${i + 1}`, paragraphs: 4, text: LOREM.repeat(2), image: 'a' })), { title: 'Lightbox' });
  const { page, errors } = await openPage({ __sampleEpub: book });
  await open(page, 'lightbox.epub');
  await wait(page, 600);
  await page.evaluate(() => window.mm.fling(9000, 150));
  await wait(page, 800);
  const opened = await page.evaluate(() => window.frame.tapImage());
  record('lightbox: tapping a picture opens it', opened);
  const before = await page.evaluate(() => ({ range: window.frame.screen().mounted, urls: window.__book.images.liveUrlCount, src: document.querySelector('.lightbox img')?.getAttribute('src') ?? null }));
  // Scroll the page under the viewer a long way: nothing is mounted or unmounted while it is open.
  await page.evaluate(() => window.mm.fling(60000, 600));
  await wait(page, 600);
  const during = await page.evaluate(() => ({ range: window.frame.screen().mounted, urls: window.__book.images.liveUrlCount, shown: document.querySelector('.lightbox img')?.complete && (document.querySelector('.lightbox img')?.naturalWidth ?? 0) > 0 }));
  record(`lightbox: the mounted chapters are left alone while it is open (${before.range.slice(0, 2).join('..')} -> ${during.range.slice(0, 2).join('..')})`, before.range[0] === during.range[0] && before.range[1] === during.range[1]);
  record('lightbox: the picture it shows is still alive (not revoked)', Boolean(during.shown) && during.urls >= before.urls - 1, JSON.stringify(during));
  await page.keyboard.press('Escape');
  await wait(page, 600);
  const closed = await page.evaluate(() => !document.querySelector('.lightbox'));
  record('lightbox: closes', closed);
  await page.evaluate(() => window.mm.fling(2000, 100));
  await wait(page, 1500);
  const after = await page.evaluate(() => ({ range: window.frame.screen().mounted, h: document.documentElement.scrollHeight }));
  record(`lightbox: once closed the window follows the reader again (${after.range.slice(0, 2).join('..')}, page ${(after.h / 1e3).toFixed(0)}k px)`, after.range[0] > before.range[0] && after.h < MAX_MOUNTED_PX);
  record('lightbox: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();

  // Expand Grid: a wide table opened in the viewer is a copy, and what it holds (here nothing to revoke) is pinned too.
  const wide = await epub(Array.from({ length: 80 }, (_, i) => ({ title: `Chapter ${i + 1}`, paragraphs: 3, text: LOREM.repeat(2), wideTable: true })), { title: 'Wide tables' });
  const grid = await openPage({ __sampleEpub: wide });
  await open(grid.page, 'wide.epub');
  await wait(grid.page, 600);
  await grid.page.evaluate(() => window.mm.fling(9000, 150));
  await wait(grid.page, 1500);
  const clicked = await grid.page.evaluate(async () => {
    const button = Array.from(document.querySelectorAll('.reader-content button')).find((b) => /Expand Grid/.test(b.textContent ?? ''));
    if (!button) return false;
    button.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 200));
    button.click();
    await new Promise((r) => setTimeout(r, 500));
    return Boolean(document.querySelector('.lightbox'));
  });
  record('expand grid: the Expand Grid button of an adapted table opens the grid in the viewer', clicked);
  const gridBefore = await grid.page.evaluate(() => window.frame.screen().mounted);
  await grid.page.evaluate(() => window.mm.fling(60000, 600));
  await wait(grid.page, 600);
  const gridDuring = await grid.page.evaluate(() => ({ range: window.frame.screen().mounted, rows: document.querySelectorAll('.lightbox table tr').length }));
  record(`expand grid: the mounted chapters are left alone while the grid is open (${gridBefore.slice(0, 2).join('..')} -> ${gridDuring.range.slice(0, 2).join('..')}), and the grid still has its rows`, gridBefore[0] === gridDuring.range[0] && gridBefore[1] === gridDuring.range[1] && gridDuring.rows >= 5, `${gridDuring.rows} rows`);
  await grid.page.keyboard.press('Escape');
  await wait(grid.page, 500);
  record('expand grid: closes, and the window follows the reader again', await grid.page.evaluate(async () => {
    window.scrollBy(0, 3000);
    await new Promise((r) => setTimeout(r, 1200));
    return !document.querySelector('.lightbox') && document.documentElement.scrollHeight < 1_500_000;
  }));
  record('expand grid: no uncaught page errors', grid.errors.length === 0, grid.errors.join('; '));
  await grid.page.close();
}

// ---- 5. font size in the middle of a long book -----------------------------------------------------------------------------------------
if (only.includes('font')) {
  const { page, errors } = await openPage({ __sampleEpub: await epub(Array.from({ length: 160 }, (_, i) => ({ title: `Chapter ${i + 1}`, paragraphs: 6, text: LOREM.repeat(2) })), { title: 'Fonts' }) });
  await open(page, 'fonts.epub', 80);
  await wait(page, 1200);
  const start = await page.evaluate(() => window.mm.visibleBlock());
  const startChapter = start?.id.split(':')[0];
  record(`font: the book opens mid-way at chapter ${startChapter}, with a short page`, startChapter === '80' && (await page.evaluate(() => document.documentElement.scrollHeight)) < MAX_MOUNTED_PX, JSON.stringify(start));
  for (const label of ['A+', 'A+', 'A+', 'A-', 'A-']) {
    await page.evaluate(() => window.scrollBy(0, 1));
    await page.getByRole('button', { name: 'Aa' }).click().catch(() => {});
    await page.getByRole('button', { name: label, exact: true }).click().catch(() => {});
    await wait(page, 1400);
    await page.getByRole('button', { name: 'Aa' }).click().catch(() => {});
    await wait(page, 300);
  }
  const end = await page.evaluate(() => ({ block: window.mm.visibleBlock(), range: window.frame.screen().mounted }));
  record(`font: after changing the size five times the same chapter is still on screen (${end.block?.id})`, end.block?.id.split(':')[0] === startChapter, JSON.stringify(end));
  record('font: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- 6. close and reopen in the middle of a long book -----------------------------------------------------------------------------------------
if (only.includes('reopen')) {
  const { page, errors } = await openPage({ __sampleEpub: await tallEpub() });
  const opened = await open(page, 'tall.epub', 100);
  await wait(page, 1000);
  const s = await page.evaluate(() => ({ snap: window.mm.snapshot(), block: window.mm.visibleBlock(), shown: window.frame.screen() }));
  record(`reopen: a saved position at chapter 100 of 150 opens there (${s.block?.id}), in ${opened.firstTextMs} ms, with ${s.snap.chapters} chapters mounted`, s.block?.id.split(':')[0] === '100' && s.snap.chapters < 12 && s.snap.pageHeight < MAX_MOUNTED_PX, JSON.stringify(s.shown.mounted));
  record('reopen: the screen is painted', (await ink(page)) > 0.002);
  record('reopen: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- 7. the 100,000-word Word document --------------------------------------------------------------------------------------------------------
if (only.includes('docx')) {
  const docxPath = join(repo, 'node_modules/.cache/vach-bench/docx/words-100k.docx');
  let base64 = null;
  try {
    base64 = readFileSync(docxPath).toString('base64');
  } catch {
    console.log('SKIPPED docx: run node scripts/bench/gen-docx-bench.mjs first');
  }
  if (base64) {
    const { page, errors } = await openPage({ __sampleDocx: base64 });
    const opened = await open(page, 'words.docx');
    await wait(page, 1000);
    const down = await traverse(page, { perFrame: 300, direction: 1, chunk: 100000, label: 'docx fling down' });
    record('docx: a fling from the top to the end reaches the last section, nothing blank', down.reachedEnd && down.blank === 0 && down.stalls === 0, `${down.blank}/${down.inks.length} blank, ${down.stalls} stalled`);
    const up = await traverse(page, { perFrame: 300, direction: -1, chunk: 100000, label: 'docx fling up' });
    record('docx: and back to the top', up.reachedEnd && up.blank === 0, `${up.blank}/${up.inks.length} blank`);
    record(`docx: opened with text after ${opened.firstTextMs} ms, no uncaught page errors`, errors.length === 0, errors.join('; '));
    await page.close();
  }
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
