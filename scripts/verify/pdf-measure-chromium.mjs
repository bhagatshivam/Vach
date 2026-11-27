#!/usr/bin/env node
// What a long PDF (and a big EPUB, for the reopen numbers) costs the reader, measured in headless Chromium with the REAL reader,
// REAL pdf.js (its worker included) and the real EPUB opener; only the native file bridge is faked, by HTTP range requests to
// this script (so a 100 MB file is never held in the page). Per book it records:
//   - time to first text, and (when every page is extracted up front) time until all text is extracted
//   - JS heap, total memory (RSS of every browser process), renderer CPU seconds, DOM nodes, mounted pages, page height
//   - frame gaps in fast flings (30,000 px at 300 px per frame, ten in a row from the top)
//   - a continuous traverse checking PAINTED pixels
//   - far Contents jumps: time until the target page is on screen, and whether the wait bar showed
//   - reopen in the same page (what a warm reopen costs): time from tap to first text, native bridge calls and bytes, at 0 and 5 ms per call
//
//   node scripts/verify/gen-pdfs.mjs && node scripts/bench/gen-fixtures.mjs --out node_modules/.cache/vach-bench/fixtures --big
//   node scripts/verify/pdf-measure-chromium.mjs [--label before] [--only text-1000,scans-100mb,...] [--out file.json]
//   node scripts/verify/pdf-measure-chromium.mjs --table before.json after.json
//
// CPU_SLOWDOWN (default 4) throttles the CPU like a mid-range phone. Desktop Chromium, not a phone: compare labels with each other.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(join(repo, 'package.json'));
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

if (args.includes('--table')) {
  const [b, a] = args.slice(args.indexOf('--table') + 1);
  console.log(comparison(JSON.parse(readFileSync(b, 'utf8')), JSON.parse(readFileSync(a, 'utf8'))));
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.log('SKIPPED: Playwright is not installed here, so there is no headless Chromium to measure with.');
  process.exit(0);
}

const label = opt('--label', 'run');
const CPU = Number(process.env.CPU_SLOWDOWN ?? 4);
const cache = join(repo, 'node_modules/.cache/vach-bench');
const BOOKS = {
  'scans-modern': { file: 'scans-modern.pdf', dir: 'pdf', pdf: true, title: 'PDF, 300 scanned pages (98 MB, cross-reference in object streams)', outline: false },
  'text-1000': { file: 'text-1000.pdf', dir: 'pdf', pdf: true, title: 'PDF, 1,000 text pages (1.4 MB)', outline: true },
  'scans-100mb': { file: 'scans-100mb.pdf', dir: 'pdf', pdf: true, title: 'PDF, 300 scanned pages (98 MB, classic cross-reference)', outline: false },
  'text-3000': { file: 'text-3000.pdf', dir: 'pdf', pdf: true, title: 'PDF, 3,000 text pages (4.3 MB)', outline: true },
  'text-4500': { file: 'text-4500.pdf', dir: 'pdf', pdf: true, title: 'PDF, 4,500 text pages (6.5 MB)', outline: true },
  'epub-a': { file: 'epub-a.epub', dir: 'fixtures', pdf: false, title: 'EPUB, 1,500 chapters (4 MB, read whole)', outline: true },
  'epub-d100': { file: 'epub-d100.epub', dir: 'fixtures', pdf: false, title: 'EPUB, 98 MB with pictures (ranged reads)', outline: true },
};
const only = (opt('--only', 'text-1000,scans-100mb,scans-modern,text-3000,epub-a,epub-d100') ?? '').split(',').filter(Boolean);

// ---- the page bundle ----------------------------------------------------------------------------------------------------------
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
const outDir = join(cache, 'verify-pdf');
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

// ---- serving the files and the worker -------------------------------------------------------------------------------------------
const fileCache = new Map();
const bytesOf = (book) => {
  if (!fileCache.has(book.file)) fileCache.set(book.file, readFileSync(join(cache, book.dir, book.file)));
  return fileCache.get(book.file);
};
async function serve(page) {
  await page.route('http://vach.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/files/')) {
      const name = decodeURIComponent(url.pathname.slice('/files/'.length));
      const book = Object.values(BOOKS).find((b) => b.file === name);
      const bytes = book ? bytesOf(book) : null;
      if (!bytes) return route.fulfill({ status: 404, body: 'no such file' });
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

// ---- process numbers ----------------------------------------------------------------------------------------------------------------------
function browserProcesses() {
  const out = execSync('ps -eo pid=,rss=,args=', { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.includes('chrome-headless-shell') || l.includes('/opt/pw-browsers')).map((l) => l.trim().split(/\s+/)).map(([pid, rss]) => ({ pid: Number(pid), rssKB: Number(rss) }));
}
const rssMB = () => Math.round(browserProcesses().reduce((n, p) => n + p.rssKB, 0) / 1024);
function cpuSeconds() {
  let ticks = 0;
  for (const { pid } of browserProcesses()) {
    try {
      const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      ticks += Number(f[11]) + Number(f[12]);
    } catch {
      /* process gone */
    }
  }
  return ticks / 100;
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
  }, [shot.toString('base64'), [244, 236, 216]]);
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// ---- one book ------------------------------------------------------------------------------------------------------------------------------
async function measure(key) {
  const book = BOOKS[key];
  if (!existsSync(join(cache, book.dir, book.file))) throw new Error(`missing ${book.file}: run gen-pdfs.mjs / gen-fixtures.mjs --big first`);
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const page = await browser.newPage({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await serve(page);
  await page.goto('http://vach.test/');
  await page.addStyleTag({ content: css });
  await page.evaluate(() => Object.assign(window, { __sampleEpub: '', __sampleDocx: '' }));
  await page.addScriptTag({ content: script });
  console.log(`\n== ${book.title}`);
  const r = { key, title: book.title, pdf: book.pdf };
  const bridge = () => page.evaluate(() => ({ ...window.__bridge }));

  // first open in a fresh page
  r.rssIdleMB = rssMB();
  const cpu0 = cpuSeconds();
  const t0 = Date.now();
  const opened = await page.evaluate(([f]) => window.mm.openTimed({ theme: 'sepia' }, f), [book.file]);
  r.firstTextMs = opened.firstTextMs;
  r.openBridge = await bridge();
  // Until every page's text is extracted (a PDF that extracts everything up front shows "Loading more..." until then).
  let allTextMs = null;
  const limit = Number(process.env.ALL_TEXT_LIMIT_S ?? 600) * 1000;
  while (book.pdf && Date.now() - t0 < limit) {
    const { loading, mounted } = await page.evaluate(() => ({ loading: Boolean(document.querySelector('.loading-more')), mounted: document.querySelectorAll('.reader-content > .chapter').length }));
    if (!loading) {
      allTextMs = Date.now() - t0;
      break;
    }
    // A reader that mounts only a window of the book shows "Loading more..." until the window reaches the end: it never extracts everything.
    if (Date.now() - t0 > 8000 && mounted < 60) break;
    await page.waitForTimeout(250);
  }
  r.allTextMs = allTextMs; // null: not everything after the limit (or never, when the reader only extracts what it needs); an EPUB is never waited for
  await page.waitForTimeout(2500);
  const snap = await page.evaluate(() => window.mm.snapshot());
  Object.assign(r, { nodes: snap.nodes, chapters: snap.chapters, pageHeight: snap.pageHeight, heapMB: await heapMB(cdp), rssMB: rssMB(), cpuOpenS: Math.round((cpuSeconds() - cpu0) * 10) / 10, openedAfterS: Math.round((Date.now() - t0) / 1000) });
  console.log(JSON.stringify({ firstTextMs: r.firstTextMs, allTextMs: r.allTextMs, chapters: r.chapters, nodes: r.nodes, pageHeightMpx: +(r.pageHeight / 1e6).toFixed(2), heapMB: r.heapMB, rssMB: r.rssMB, cpuOpenS: r.cpuOpenS, bridge: r.openBridge }));

  // ten fast flings in a row from the top
  const flings = [];
  const inks = [];
  for (let i = 0; i < 10; i++) {
    const s = await page.evaluate(() => window.mm.fling(30000, 300));
    flings.push(s);
    inks.push(await ink(page));
    if (s.reachedEnd) break;
  }
  r.fling = {
    flings: flings.length,
    maxGapMs: Math.max(...flings.map((f) => f.maxGapMs)),
    medianP95GapMs: median(flings.map((f) => f.p95GapMs)),
    gapsOver50: flings.reduce((n, f) => n + f.over50, 0),
    stalls: flings.reduce((n, f) => n + f.stallFrames, 0),
    maxPageHeight: Math.max(...flings.map((f) => f.maxPageHeight)),
    blank: inks.filter((v) => v < 0.002).length,
    screens: inks.length,
  };
  console.log('flings', JSON.stringify(r.fling));
  r.heapAfterFlingsMB = await heapMB(cdp);
  r.rssAfterFlingsMB = rssMB();

  // reopen in the same page: the first open's costs again, with everything the page and the OS have warmed up
  r.reopen = {};
  for (const latency of [0, 5]) {
    await page.evaluate((ms) => { window.__bridgeLatencyMs = ms; window.__bridge.calls = 0; window.__bridge.bytes = 0; }, latency);
    const mid = book.pdf ? 500 : 750;
    const reopened = await page.evaluate(([f, saved]) => window.mm.openTimed({ theme: 'sepia' }, f, saved), [book.file, mid]);
    await page.waitForTimeout(1500);
    const used = await bridge();
    r.reopen[`${latency}ms`] = { firstTextMs: reopened.firstTextMs, calls: used.calls, bytes: used.bytes };
  }
  await page.evaluate(() => { window.__bridgeLatencyMs = 0; });
  console.log('reopen (saved position mid-book)', JSON.stringify(r.reopen));

  // The part of opening that a metadata cache could skip, on its own: reading the index (an EPUB's central directory and
  // table of contents; a PDF's cross-reference table, page tree and outline), with the native round trip at 0, 5 and 20 ms.
  r.index = {};
  for (const latency of [0, 5, 20]) {
    await page.evaluate((ms) => { window.__bridgeLatencyMs = ms; }, latency);
    const timed = await page.evaluate(([f, isPdf]) => (isPdf ? window.mm.timeOpenPdf(f) : window.mm.timeEpubIndex(f)), [book.file, book.pdf]);
    r.index[`${latency}ms`] = timed;
  }
  await page.evaluate(() => { window.__bridgeLatencyMs = 0; });
  console.log('index only (what a cache could skip)', JSON.stringify(r.index));

  // far Contents jumps: first right after opening (a PDF that extracts everything up front has not got there yet), then once things have settled
  if (book.pdf && book.outline) {
    r.jumps = [];
    const jump = async (title, group) => {
      const target = Number(/page (\d+)/.exec(title)?.[1] ?? NaN) - 1;
      if (!(await page.evaluate(() => Boolean(document.querySelector('.toc-panel'))))) await page.evaluate(() => window.frame.openToc());
      const j = await page.evaluate(([t, p]) => window.mm.timedJump(t, p), [title, target]);
      r.jumps.push({ group, title, target, ...j });
    };
    await page.evaluate((f) => window.mm.openTimed({ theme: 'sepia' }, f), book.file);
    const titles = await page.evaluate(() => window.mm.tocTitles());
    if (titles && titles.length > 2) {
      await jump(titles[titles.length - 1], 'right after opening');
      await page.waitForTimeout(Number(process.env.ALL_TEXT_LIMIT_S ?? 600) > 0 ? 12000 : 1000);
      for (const index of [Math.floor(titles.length / 2), Math.floor(titles.length * 0.9), 1, titles.length - 1]) {
        await jump(titles[index], 'later');
        await page.waitForTimeout(800);
      }
      console.log('jumps', JSON.stringify(r.jumps));
    }
  }

  // one continuous traverse from the start, on painted pixels
  if (book.pdf) {
    await page.evaluate((f) => window.mm.openTimed({ theme: 'sepia' }, f), book.file);
    // A build that extracts every page up front is traversed once it has finished (a fling outruns the text pass otherwise,
    // and the page is not its full height yet); one that extracts on demand is traversed straight away.
    if (r.allTextMs !== null) {
      for (let i = 0; i < 480 && (await page.evaluate(() => Boolean(document.querySelector('.loading-more')))); i++) await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1500);
    const traverse = { checks: 0, blank: 0, firstBlankAtY: null, maxPageHeight: 0, travelledMpx: 0, stalls: 0, reachedEnd: false };
    const started = Date.now();
    for (let i = 0; i < 400 && !traverse.reachedEnd && Date.now() - started < 12 * 60 * 1000; i++) {
      const s = await page.evaluate(() => window.mm.fling(150000, 2000, { sampleEvery: 25 }));
      traverse.travelledMpx += s.distance / 1e6;
      traverse.maxPageHeight = Math.max(traverse.maxPageHeight, s.maxPageHeight);
      traverse.stalls += s.stallFrames;
      traverse.reachedEnd = s.reachedEnd || s.stuck;
      await page.waitForTimeout(book.pdf && key === 'scans-100mb' ? 600 : 100);
      const v = await ink(page);
      traverse.checks++;
      if (v < 0.002) {
        traverse.blank++;
        traverse.firstBlankAtY ??= await page.evaluate(() => Math.round(window.scrollY));
      }
    }
    traverse.travelledMpx = +traverse.travelledMpx.toFixed(2);
    traverse.seconds = Math.round((Date.now() - started) / 1000);
    r.traverse = traverse;
    r.heapAfterTraverseMB = await heapMB(cdp);
    r.rssAfterTraverseMB = rssMB();
    console.log('traverse', JSON.stringify(traverse), 'heap', r.heapAfterTraverseMB, 'rss', r.rssAfterTraverseMB);
  }
  r.errors = errors.slice(0, 3);
  await browser.close();
  return r;
}

const results = { label, cpuSlowdown: CPU, at: new Date().toISOString(), books: {} };
for (const key of only) {
  if (!BOOKS[key]) continue;
  try {
    results.books[key] = await measure(key);
  } catch (error) {
    console.log(`FAILED ${key}: ${error}`);
  }
}
const out = opt('--out', null);
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
console.log('\n' + summary(results));

function summary(r) {
  const rows = Object.values(r.books);
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [
    `**${r.label}** (CPU x${r.cpuSlowdown}, 360x800)`,
    '',
    line(['Book', 'first text', 'all text', 'mounted / nodes', 'page height', 'JS heap / RSS', 'CPU to open', 'fling gap max / p95 / >50ms', 'reopen mid-book (0 / 5 ms bridge)']),
    line(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---', '---']),
    ...rows.map((s) =>
      line([
        s.title,
        `${s.firstTextMs} ms`,
        s.allTextMs === null ? 'not extracted up front' : `${(s.allTextMs / 1000).toFixed(1)} s`,
        `${s.chapters} / ${s.nodes.toLocaleString('en-US')}`,
        `${(s.pageHeight / 1e6).toFixed(2)}M px`,
        `${s.heapMB} MB / ${s.rssMB} MB (idle browser ${s.rssIdleMB})`,
        `${s.cpuOpenS} s`,
        `${s.fling.maxGapMs} / ${s.fling.medianP95GapMs} / ${s.fling.gapsOver50} ms`,
        `${s.reopen['0ms'].firstTextMs} ms (${s.reopen['0ms'].calls} calls) / ${s.reopen['5ms'].firstTextMs} ms`,
      ]),
    ),
  ].join('\n');
}

function comparison(b, a) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  const out = [line(['', 'before', 'after']), line(['---', '---:', '---:'])];
  const fmtAll = (s) => (s.allTextMs === null ? 'not extracted up front' : `${(s.allTextMs / 1000).toFixed(1)} s`);
  for (const k of Object.keys(b.books).filter((x) => a.books[x])) {
    const x = b.books[k];
    const y = a.books[k];
    const m = (v) => `${(v / 1e6).toFixed(2)}M px`;
    out.push(line([`**${x.title}**`, '', '']));
    out.push(line(['time to first text', `${x.firstTextMs} ms`, `${y.firstTextMs} ms`]));
    out.push(line(['time until all text is extracted', fmtAll(x), fmtAll(y)]));
    out.push(line(['pages mounted / DOM nodes', `${x.chapters} / ${x.nodes.toLocaleString('en-US')}`, `${y.chapters} / ${y.nodes.toLocaleString('en-US')}`]));
    out.push(line(['page height', m(x.pageHeight), m(y.pageHeight)]));
    out.push(line(['JS heap after open / after flings', `${x.heapMB} / ${x.heapAfterFlingsMB} MB`, `${y.heapMB} / ${y.heapAfterFlingsMB} MB`]));
    out.push(line([`total memory (RSS of every browser process; ${x.rssIdleMB} MB idle) after open / flings / traverse`, `${x.rssMB} / ${x.rssAfterFlingsMB} / ${x.rssAfterTraverseMB ?? '-'} MB`, `${y.rssMB} / ${y.rssAfterFlingsMB} / ${y.rssAfterTraverseMB ?? '-'} MB`]));
    out.push(line(['renderer CPU seconds from tap to settled', `${x.cpuOpenS} s`, `${y.cpuOpenS} s`]));
    out.push(line(['fling frame gaps: max / median p95 / over 50 ms', `${x.fling.maxGapMs} / ${x.fling.medianP95GapMs} / ${x.fling.gapsOver50}`, `${y.fling.maxGapMs} / ${y.fling.medianP95GapMs} / ${y.fling.gapsOver50}`]));
    if (x.traverse && y.traverse) {
      out.push(line(['traverse: largest page height / blank screens', `${m(x.traverse.maxPageHeight)} / ${x.traverse.blank} of ${x.traverse.checks}${x.traverse.firstBlankAtY ? ` (from y=${x.traverse.firstBlankAtY.toLocaleString('en-US')})` : ''}`, `${m(y.traverse.maxPageHeight)} / ${y.traverse.blank} of ${y.traverse.checks}${y.traverse.firstBlankAtY ? ` (from y=${y.traverse.firstBlankAtY.toLocaleString('en-US')})` : ''}`]));
    }
    if (x.jumps?.length && y.jumps?.length) {
      const j = (list) => list.map((q) => (q.error ? q.error : `${q.ms} ms${q.waitBar ? ` (wait bar ${q.waitBarMs} ms)` : ''}`)).join('; ');
      out.push(line(['Contents jumps: last entry right after opening; later the middle, 90%, second, last', j(x.jumps), j(y.jumps)]));
    }
    out.push(line(['reopen, saved position mid-book: first text (bridge calls)', `${x.reopen['0ms'].firstTextMs} ms (${x.reopen['0ms'].calls}) / ${x.reopen['5ms'].firstTextMs} ms at 5 ms per call`, `${y.reopen['0ms'].firstTextMs} ms (${y.reopen['0ms'].calls}) / ${y.reopen['5ms'].firstTextMs} ms at 5 ms per call`]));
  }
  return out.join('\n');
}
