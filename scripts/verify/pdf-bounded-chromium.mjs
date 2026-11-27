#!/usr/bin/env node
// Long PDFs in headless Chromium: the REAL reader, REAL pdf.js (worker included), phone-sized viewport, throttled CPU, files served
// by range requests (the fake native bridge). Checks, on what is PAINTED (pixels, not the DOM):
//   - a 3,000-page and a 4,500-page PDF flung from the first page to the last: no blank screen anywhere (Chromium paints nothing
//     past 2^23 px of scroll offset, and 4,500 text pages are 8.9M px when every page is mounted), the page never taller than the cap
//   - heap and DOM flat; only the pages near the reader are mounted
//   - a jump through Contents to the first, middle and last page is immediate, with no wait bar
//   - a scanned PDF: pages are rasterized as they come near, and let go of as they leave
//   - font size in the middle of a PDF, and reopening mid-PDF, keep the place
//
//   node scripts/verify/gen-pdfs.mjs && node scripts/verify/pdf-bounded-chromium.mjs        (ONLY=big,jumps,scans,font,reopen to pick)
//
// CPU_SLOWDOWN (default 4) throttles the CPU like a mid-range phone.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
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

const only = (process.env.ONLY ?? 'big,jumps,scans,font,reopen').split(',');
const CPU = Number(process.env.CPU_SLOWDOWN ?? 4);
const MAX_MOUNTED_PX = 1_500_000;
const cache = join(repo, 'node_modules/.cache/vach-bench/pdf');
for (const name of ['text-1000.pdf', 'text-3000.pdf', 'text-4500.pdf', 'scans-modern.pdf']) {
  if (!existsSync(join(cache, name))) {
    console.log(`SKIPPED: ${name} is missing - run node scripts/verify/gen-pdfs.mjs first.`);
    process.exit(0);
  }
}

const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
const outDir = join(repo, 'node_modules/.cache/vach-bench/verify-pdf-bounded');
const stub = (pattern, file) => ({ name: `stub-${file}`, enforce: 'pre', resolveId: (source) => (pattern.test(source) ? join(here, file) : null) });
await build({
  root: repo,
  configFile: false,
  logLevel: 'error',
  plugins: [stub(/(^|\/)docxFile(\.ts)?$/, 'docxFileStub.ts'), stub(/(^|\/)libraryFolder(\.ts)?$/, 'libraryFolderStub.ts'), stub(/(^|\/)fileBridge(\.ts)?$/, 'fileBridgeRangeStub.ts'), react()],
  worker: { format: 'es' },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: { outDir, emptyOutDir: true, minify: false, cssCodeSplit: false, lib: { entry: join(here, 'measure-entry.tsx'), name: 'vachMeasure', formats: ['iife'], fileName: () => 'measure-entry.js' } },
});
const script = readFileSync(join(outDir, 'measure-entry.js'), 'utf8');
const css = readdirSync(outDir).filter((n) => n.endsWith('.css')).map((n) => readFileSync(join(outDir, n), 'utf8')).join('\n');

const files = new Map();
async function serve(page) {
  await page.route('http://vach.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/files/')) {
      const name = decodeURIComponent(url.pathname.slice('/files/'.length));
      if (!files.has(name)) files.set(name, readFileSync(join(cache, name)));
      const bytes = files.get(name);
      const range = /bytes=(\d+)-(\d+)?/.exec(route.request().headers().range ?? '');
      if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'content-length': String(bytes.length), 'accept-ranges': 'bytes' }, body: '' });
      if (!range) return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: bytes });
      const begin = Number(range[1]);
      const end = Math.min(bytes.length - 1, range[2] ? Number(range[2]) : bytes.length - 1);
      return route.fulfill({ status: 206, headers: { 'content-range': `bytes ${begin}-${end}/${bytes.length}`, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' }, body: bytes.subarray(begin, end + 1) });
    }
    if (url.pathname.startsWith('/assets/')) {
      const file = join(outDir, url.pathname);
      return existsSync(file) ? route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(file) }) : route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"></head><body><div id="root"></div></body></html>' });
  });
}

const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

async function openPage(viewport = { width: 360, height: 800 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await serve(page);
  await page.goto('http://vach.test/');
  await page.addStyleTag({ content: css });
  await page.evaluate(() => Object.assign(window, { __sampleEpub: '', __sampleDocx: '' }));
  await page.addScriptTag({ content: script });
  return { page, cdp, errors };
}
async function heapMB(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return Math.round((usedSize / 1048576) * 10) / 10;
}
const rssByProcess = () => execSync('ps -eo rss=,args=', { encoding: 'utf8' }).split('\n').filter((l) => l.includes('chrome-headless-shell')).map((l) => { const [rss, ...rest] = l.trim().split(/\s+/); return `${/--type=([a-z-]+)/.exec(rest.join(' '))?.[1] ?? 'browser'}:${Math.round(Number(rss) / 1024)}`; }).join(' ');
const rssMB = () => Math.round(execSync('ps -eo rss=,args=', { encoding: 'utf8' }).split('\n').filter((l) => l.includes('chrome-headless-shell')).reduce((n, l) => n + Number(l.trim().split(/\s+/)[0]), 0) / 1024);
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
  }, [shot.toString('base64'), [244, 236, 216]]);
}
const open = (page, file, saved) => page.evaluate(([f, s]) => window.mm.openTimed({ theme: 'sepia' }, f, s ?? undefined), [file, saved ?? null]);

// ---- 1. 3,000 and 4,500 pages flung from the first page to the last --------------------------------------------------------------------
if (only.includes('big')) {
  for (const [file, pages] of [['text-3000.pdf', 3000], ['text-4500.pdf', 4500]]) {
    const { page, cdp, errors } = await openPage();
    const opened = await open(page, file);
    await page.waitForTimeout(2000);
    const start = await page.evaluate(() => window.mm.snapshot());
    const heapStart = await heapMB(cdp);
    record(`${pages} pages: opens with a handful of pages mounted, not all of them (${start.chapters} pages, ${start.nodes} nodes, ${(start.pageHeight / 1e3).toFixed(0)}k px, text after ${opened.firstTextMs} ms)`, start.chapters < 20 && start.pageHeight < MAX_MOUNTED_PX);

    const inks = [];
    let maxHeight = 0;
    let maxMounted = 0;
    let maxNodes = 0;
    let stalls = 0;
    let travelled = 0;
    let reachedEnd = false;
    const started = Date.now();
    for (let i = 0; i < 500 && !reachedEnd && Date.now() - started < 14 * 60 * 1000; i++) {
      const s = await page.evaluate(() => window.mm.fling(120000, 600, { sampleEvery: 25 }));
      travelled += s.distance;
      maxHeight = Math.max(maxHeight, s.maxPageHeight);
      maxMounted = Math.max(maxMounted, s.maxMounted);
      stalls += s.stallFrames;
      reachedEnd = s.reachedEnd || s.stuck;
      maxNodes = Math.max(maxNodes, (await page.evaluate(() => window.mm.snapshot())).nodes);
      await page.waitForTimeout(300);
      inks.push(await ink(page));
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`  ${pages} pages, fling down at 600 px per frame (about 4x a hard swipe): ${(travelled / 1e6).toFixed(2)}M px in ${seconds}s, ${inks.length} screens checked, page at most ${(maxHeight / 1e3).toFixed(0)}k px, at most ${maxMounted} pages and ${maxNodes} DOM nodes, ${stalls} stalled frames (waiting for a page to be extracted)`);
    const last = await page.evaluate(() => window.frame.screen().visible.map((v) => v.marker));
    record(`${pages} pages: the fling reaches the last page`, reachedEnd && last.includes(String(pages - 1)), `on screen: ${last.join(',')}`);
    record(`${pages} pages: no blank screen anywhere from the first page to the last (painted pixels)`, inks.every((v) => v > 0.002), `${inks.filter((v) => v <= 0.002).length}/${inks.length} blank`);
    record(`${pages} pages: the page never got taller than ${MAX_MOUNTED_PX.toLocaleString('en-US')} px (it would be ${pages === 3000 ? '5.9' : '8.9'}M px with every page mounted)`, maxHeight <= MAX_MOUNTED_PX, `${maxHeight.toLocaleString('en-US')} px`);
    record(`${pages} pages: pages mounted and DOM nodes stay flat while flinging (${maxMounted} pages, ${maxNodes} nodes at most)`, maxMounted <= 20 && maxNodes < 600);
    const heapEnd = await heapMB(cdp);
    record(`${pages} pages: JS heap stays flat across the whole PDF (${heapStart} -> ${heapEnd} MB)`, heapEnd < heapStart * 2 + 6);

    // and straight back to the first page
    const back = [];
    reachedEnd = false;
    for (let i = 0; i < 500 && !reachedEnd && Date.now() - started < 28 * 60 * 1000; i++) {
      const s = await page.evaluate(() => window.mm.fling(-120000, 600, { sampleEvery: 25 }));
      reachedEnd = s.reachedEnd || s.stuck;
      maxHeight = Math.max(maxHeight, s.maxPageHeight);
      await page.waitForTimeout(300);
      back.push(await ink(page));
    }
    record(`${pages} pages: and back from the last page to the first, nothing blank, page still under the cap`, reachedEnd && back.every((v) => v > 0.002) && maxHeight <= MAX_MOUNTED_PX, `${back.filter((v) => v <= 0.002).length}/${back.length} blank`);
    record(`${pages} pages: no uncaught page errors`, errors.length === 0, errors.join('; '));
    await page.close();
  }
}

// ---- 2. jumps through Contents -------------------------------------------------------------------------------------------------------------
if (only.includes('jumps')) {
  const { page, errors } = await openPage();
  await open(page, 'text-3000.pdf');
  const titles = await page.evaluate(() => window.mm.tocTitles());
  record(`jumps: the PDF's outline has ${titles?.length ?? 0} entries`, Boolean(titles && titles.length > 10));
  const wanted = [['the last page', titles.length - 1], ['the middle', Math.floor(titles.length / 2)], ['the first entry', 0], ['the last again, from the first', titles.length - 1], ['a quarter of the way', Math.floor(titles.length / 4)]];
  for (const [what, index] of wanted) {
    const title = titles[index];
    const target = Number(/page (\d+)/.exec(title)?.[1] ?? NaN) - 1;
    if (!(await page.evaluate(() => Boolean(document.querySelector('.toc-panel'))))) await page.evaluate(() => window.frame.openToc());
    const j = await page.evaluate(([t, p]) => window.mm.timedJump(t, p), [title, target]);
    const settled = await page.evaluate(() => ({ chapters: document.querySelectorAll('.reader-content > .chapter').length, height: document.documentElement.scrollHeight }));
    record(`jumps: to ${what} ("${title}") the page is on screen in ${j.ms} ms, with no wait bar`, !j.error && j.ms < 2500 && !j.waitBar, JSON.stringify({ ...j, ...settled }));
    await page.waitForTimeout(250); // a frame or two for the compositor to paint what was just revealed
    const painted = await ink(page);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/jump-${index}.png` });
    record(`jumps: after the jump to ${what} the page is short and painted`, settled.height < MAX_MOUNTED_PX && painted > 0.002, `ink ${painted.toFixed(4)}, ${JSON.stringify(await page.evaluate(() => window.frame.screen().visible))}`);
    await page.waitForTimeout(600);
  }
  record('jumps: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- 3. a scanned PDF ---------------------------------------------------------------------------------------------------------------------------
if (only.includes('scans')) {
  const { page, cdp, errors } = await openPage();
  const opened = await open(page, 'scans-modern.pdf');
  await page.waitForTimeout(3000);
  const rendered = () => page.evaluate(() => Array.from(document.querySelectorAll('.reader-content img.pdf-page-img')).filter((i) => i.getAttribute('src')).length);
  const mountedPages = () => page.evaluate(() => document.querySelectorAll('.reader-content .pdf-page').length);
  record(`scans: a 98 MB scanned PDF opens (text after ${opened.firstTextMs} ms) with ${await mountedPages()} pages mounted`, (await mountedPages()) > 0 && (await mountedPages()) < 20);
  record('scans: the pages near the screen are rasterized and painted', (await rendered()) > 0 && (await ink(page)) > 0.01, `${await rendered()} rendered`);
  const heapStart = await heapMB(cdp);
  let maxRendered = 0;
  let maxMounted = 0;
  let blank = 0;
  let checks = 0;
  let reachedEnd = false;
  for (let i = 0; i < 100 && !reachedEnd; i++) {
    const s = await page.evaluate(() => window.mm.fling(6000, 150, { sampleEvery: 25 }));
    reachedEnd = s.reachedEnd || s.stuck;
    await page.waitForTimeout(1200);
    maxRendered = Math.max(maxRendered, await rendered());
    maxMounted = Math.max(maxMounted, await mountedPages());
    checks++;
    if ((await ink(page)) < 0.01) blank++;
  }
  record(`scans: read from the first page to the last (${checks} screens): every screen painted once its pages were rasterized`, reachedEnd && blank === 0, `${blank} blank of ${checks}`);
  record('scans: the "scanned book" notice is shown once enough pages have been read', await page.evaluate(() => /scanned book/.test(document.body.textContent ?? '')));
  record(`scans: only a few pages are held as pictures at once (at most ${maxRendered} rendered, ${maxMounted} mounted, of 300)`, maxRendered <= 24 && maxMounted <= 45);
  const heapEnd = await heapMB(cdp);
  console.log('  scans: memory by process after the read-through (MB):', rssByProcess());
  if (process.env.EXPERIMENT) {
    await page.evaluate(() => document.querySelectorAll('img.pdf-page-img').forEach((i) => i.removeAttribute('src')));
    await page.waitForTimeout(3000);
    await heapMB(cdp);
    console.log('  after clearing the page pictures:', rssByProcess());
    await page.evaluate(async () => { await window.__doc.cleanup(); });
    await page.waitForTimeout(3000);
    await heapMB(cdp);
    console.log('  after doc.cleanup():', rssByProcess());
  }
  record(`scans: JS heap stays flat (${heapStart} -> ${heapEnd} MB), total browser memory ${rssMB()} MB`, heapEnd < heapStart * 2 + 10);
  record('scans: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- 4. font size in the middle of a PDF ---------------------------------------------------------------------------------------------------------
if (only.includes('font')) {
  const { page, errors } = await openPage();
  await open(page, 'text-1000.pdf', 500);
  await page.waitForTimeout(2000);
  const startId = (await page.evaluate(() => window.mm.visibleBlock()))?.id.split(':')[0];
  record(`font: a saved position at page 500 opens on page 501 (MARK_${startId})`, startId === '500');
  for (const label of ['A+', 'A+', 'A+', 'A-']) {
    await page.getByRole('button', { name: 'Aa' }).click().catch(() => {});
    await page.getByRole('button', { name: label, exact: true }).click().catch(() => {});
    await page.waitForTimeout(1600);
    await page.getByRole('button', { name: 'Aa' }).click().catch(() => {});
    await page.waitForTimeout(300);
  }
  const endId = (await page.evaluate(() => window.mm.visibleBlock()))?.id.split(':')[0];
  record(`font: after changing the size four times the same page is on screen (MARK_${endId})`, endId === '500');
  record('font: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- 5. reopening in the middle of a PDF ---------------------------------------------------------------------------------------------------------
if (only.includes('reopen')) {
  const { page, errors } = await openPage();
  await open(page, 'text-3000.pdf');
  await page.waitForTimeout(1000);
  const reopened = await open(page, 'text-3000.pdf', 2400);
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => ({ block: window.mm.visibleBlock(), snap: window.mm.snapshot() }));
  record(`reopen: a saved position at page 2,401 of 3,000 opens there in ${reopened.firstTextMs} ms (it needed ${(4500 / 1000).toFixed(1)} s and every page before it extracted when all text was read up front)`, state.block?.id.split(':')[0] === '2400' && reopened.firstTextMs < 2500, JSON.stringify(state.block));
  record(`reopen: only a few pages are mounted (${state.snap.chapters}), the page is short`, state.snap.chapters < 20 && state.snap.pageHeight < MAX_MOUNTED_PX);
  record('reopen: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
