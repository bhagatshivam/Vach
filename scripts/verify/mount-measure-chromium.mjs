#!/usr/bin/env node
// Measures what the reader holds in the page for a long book, in headless Chromium with the real ReaderScreen, CSS,
// sanitizer, table/image controllers and Contents drawer (fake file bridge). For each book it reports: mounted chapters and
// DOM nodes, total page height, JS heap, time to first text, and the frame gaps during fast flings at ten places through
// the book, plus a continuous top-to-bottom traverse that checks PAINTED pixels (Chromium stops painting past 2^23 px).
//
//   node scripts/verify/mount-measure-chromium.mjs [--label before|after] [--only tall,ordinary,docx,pdf,pdf-scanned] [--out file.json]
//   node scripts/verify/mount-measure-chromium.mjs --table before.json after.json     (just prints the comparison table)
//
// CPU_SLOWDOWN (default 4) throttles the CPU like a mid-range phone. These are desktop-Chromium numbers: compare the
// two labels with each other, not with a phone.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(join(repo, 'package.json'));

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

if (args.includes('--table')) {
  const [beforePath, afterPath] = args.slice(args.indexOf('--table') + 1);
  console.log(comparisonTable(JSON.parse(readFileSync(beforePath, 'utf8')), JSON.parse(readFileSync(afterPath, 'utf8'))));
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.log('SKIPPED: Playwright is not installed here, so there is no headless Chromium to measure with.');
  process.exit(0);
}
const { tallEpub, ordinaryEpub, epub, LOREM } = await import('./syntheticBooks.mjs');

const label = opt('--label', 'run');
const only = (opt('--only', 'tall,ordinary,docx,pdf') ?? '').split(',').filter(Boolean);
const CPU = Number(process.env.CPU_SLOWDOWN ?? 4);

// ---- the page bundle --------------------------------------------------------------------------------------------
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
const outDir = join(repo, 'node_modules/.cache/vach-bench/verify-measure');
const stub = (pattern, file) => ({ name: `stub-${file}`, enforce: 'pre', resolveId: (source) => (pattern.test(source) ? join(here, file) : null) });
await build({
  root: repo,
  configFile: false,
  logLevel: 'warn',
  plugins: [
    stub(/(^|\/)epubFile(\.ts)?$/, 'epubFileStub.ts'),
    stub(/(^|\/)docxFile(\.ts)?$/, 'docxFileStub.ts'),
    stub(/(^|\/)libraryFolder(\.ts)?$/, 'libraryFolderStub.ts'),
    stub(/(^|\/)pdf(\.ts)?$/, 'pdfSyntheticStub.ts'),
    stub(/(^|\/)fileBridge(\.ts)?$/, 'fileBridgeStub.ts'),
    react(),
  ],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: { outDir, emptyOutDir: true, minify: false, cssCodeSplit: false, lib: { entry: join(here, 'measure-entry.tsx'), name: 'vachMeasure', formats: ['iife'], fileName: () => 'measure-entry.js' } },
});
const script = readFileSync(join(outDir, 'measure-entry.js'), 'utf8');
const css = readdirSync(outDir).filter((n) => n.endsWith('.css')).map((n) => readFileSync(join(outDir, n), 'utf8')).join('\n');

// ---- the books --------------------------------------------------------------------------------------------------
const docxPath = join(repo, 'node_modules/.cache/vach-bench/docx/words-100k.docx');
const SCENARIOS = {
  tall: { title: 'EPUB, 150 long chapters (the 10.5M px book)', file: 'tall.epub', inject: async () => ({ __sampleEpub: await tallEpub() }) },
  ordinary: { title: 'EPUB, 365 ordinary chapters (Les Miserables-sized)', file: 'ordinary.epub', inject: async () => ({ __sampleEpub: await ordinaryEpub(365) }) },
  docx: { title: 'DOCX, 100,000 words', file: 'words.docx', inject: async () => ({ __sampleDocx: readFileSync(docxPath).toString('base64') }) },
  pdf: { title: 'PDF, 3,000 dense text pages', file: 'big.pdf', inject: async () => ({ __syntheticPdf: { pages: 3000 } }) },
  pictures: {
    title: 'EPUB, 120 chapters each with its own big picture, 40 with a table, read slowly',
    file: 'pictures.epub',
    slowRead: true,
    inject: async () => ({ __sampleEpub: await epub(Array.from({ length: 120 }, (_, i) => ({ title: `Chapter ${i + 1}`, paragraphs: 5, text: LOREM.repeat(2), uniqueImage: true, table: i % 3 === 0 })), { title: 'Pictures and tables' }) }),
  },
  'pdf-4500': { title: 'PDF, 4,500 dense text pages', file: 'huge.pdf', inject: async () => ({ __syntheticPdf: { pages: 4500 } }) },
  'pdf-scanned': { title: 'PDF, 20,000 scanned pages', file: 'scans.pdf', inject: async () => ({ __syntheticPdf: { pages: 20000, scanned: true } }) },
};

const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
const VIEWPORT = { width: 360, height: 800 };
const BG = [244, 236, 216]; // sepia

async function openPage(extra) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('http://vach.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"></head><body><div id="root"></div></body></html>' }));
  await page.goto('http://vach.test/');
  await page.addStyleTag({ content: css });
  if (process.env.EXTRA_CSS) await page.addStyleTag({ content: process.env.EXTRA_CSS });
  await page.evaluate((globals) => Object.assign(window, { __sampleEpub: '', __sampleDocx: '' }, globals), extra);
  await page.addScriptTag({ content: script });
  return { page, cdp, errors };
}

async function heap(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  const { counters } = await cdp.send('Memory.getDOMCounters').then((r) => ({ counters: r }), () => ({ counters: {} }));
  return { heapMB: Math.round((usedSize / 1048576) * 10) / 10, domNodesAlive: counters.nodes ?? null, listeners: counters.jsEventListeners ?? null };
}

/** Share of the screen that is not the page colour: a blank screen has none. */
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

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function measure(key) {
  const scenario = SCENARIOS[key];
  const { page, cdp, errors } = await openPage(await scenario.inject());
  console.log(`\n== ${scenario.title}`);
  const result = { key, title: scenario.title };

  const opened = await page.evaluate(([file]) => window.mm.openTimed({ theme: 'sepia' }, file), [scenario.file]);
  result.firstTextMs = opened.firstTextMs;
  const settleMs = await page.evaluate(() => window.mm.settle());
  const snap = await page.evaluate(() => window.mm.snapshot());
  Object.assign(result, { chapters: snap.chapters, nodes: snap.nodes, pageHeight: snap.pageHeight, settleMs: Math.round(settleMs), ...(await heap(cdp)) });
  console.log(JSON.stringify({ firstTextMs: result.firstTextMs, chapters: result.chapters, nodes: result.nodes, pageHeightMpx: +(result.pageHeight / 1e6).toFixed(2), heapMB: result.heapMB }));

  // Fast flings (300 px per frame, about twice what a hard swipe reaches) at ten places through the book.
  const titles = (await page.evaluate(() => window.mm.tocTitles())) ?? [];
  const flings = [];
  const inks = [];
  for (let k = 0; k < 10; k++) {
    const fraction = k / 10;
    if (titles.length > 1) {
      const title = titles[Math.min(titles.length - 1, Math.floor(fraction * titles.length))];
      await page.evaluate((t) => window.frame.jumpTo(t), title);
    } else {
      await page.evaluate((f) => window.scrollTo(0, f * (document.documentElement.scrollHeight - window.innerHeight)), fraction);
      await page.waitForTimeout(400);
    }
    inks.push(await ink(page));
    const stats = await page.evaluate(() => window.mm.fling(30000, 300));
    flings.push(stats);
    inks.push(await ink(page));
  }
  result.fling = {
    positions: flings.length,
    maxGapMs: Math.max(...flings.map((f) => f.maxGapMs)),
    medianP95GapMs: median(flings.map((f) => f.p95GapMs)),
    gapsOver50: flings.reduce((n, f) => n + f.over50, 0),
    gapsOver100: flings.reduce((n, f) => n + f.over100, 0),
    stalls: flings.reduce((n, f) => n + f.stallFrames, 0),
    stuck: flings.filter((f) => f.stuck).length,
    maxPageHeight: Math.max(...flings.map((f) => f.maxPageHeight)),
    maxMounted: Math.max(...flings.map((f) => f.maxMounted)),
    blankScreens: inks.filter((v) => v < 0.002).length,
    screensChecked: inks.length,
  };
  console.log('flings', JSON.stringify(result.fling));

  // One continuous traverse from the top to the bottom, checking the painted screen every 150k px.
  await page.evaluate(() => window.scrollTo(0, 0));
  if (titles.length > 1) await page.evaluate((t) => window.frame.jumpTo(t), titles[0]);
  await page.waitForTimeout(500);
  const traverseInks = [];
  let travelled = 0;
  let traverseMax = 0;
  let traverseStall = 0;
  let reachedEnd = false;
  const traverseStart = Date.now();
  for (let i = 0; i < 400 && !reachedEnd; i++) {
    const stats = await page.evaluate(() => window.mm.fling(150000, 2000, { sampleEvery: 25 }));
    travelled += stats.distance;
    traverseMax = Math.max(traverseMax, stats.maxPageHeight);
    traverseStall += stats.stallFrames;
    reachedEnd = stats.reachedEnd || stats.stuck;
    const y = await page.evaluate(() => Math.round(window.scrollY));
    traverseInks.push([y, await ink(page)]);
    if (Date.now() - traverseStart > 12 * 60 * 1000) break;
  }
  result.traverse = {
    travelledMpx: +(travelled / 1e6).toFixed(2),
    reachedEnd,
    checks: traverseInks.length,
    blank: traverseInks.filter(([, v]) => v < 0.002).length,
    firstBlankAtY: traverseInks.find(([, v]) => v < 0.002)?.[0] ?? null,
    maxPageHeight: traverseMax,
    stallFrames: traverseStall,
    seconds: Math.round((Date.now() - traverseStart) / 1000),
  };
  console.log('traverse', JSON.stringify(result.traverse));

  // A book with pictures is also READ, slowly enough for each picture to be downscaled as it comes near: how many blob: URLs
  // (downscaled pictures) the book holds at the most, and what the heap is, after reading it through.
  if (scenario.slowRead) {
    await page.evaluate(() => window.scrollTo(0, 0));
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      const stats = await page.evaluate(() => window.mm.fling(1800, 120));
      await page.waitForTimeout(160);
      peak = Math.max(peak, await page.evaluate(() => window.__book?.images.liveUrlCount ?? 0));
      if (stats.reachedEnd) break;
    }
    result.blobUrlsPeak = peak;
    await page.waitForTimeout(2500);
  }
  // Pictures downscaled and shown while reading: how many blob: URLs the book still holds now, and how many <img> are mounted.
  const held = await page.evaluate(() => ({ blobUrls: window.__book?.images.liveUrlCount ?? null, imgs: document.querySelectorAll('.reader-content img').length }));
  Object.assign(result, { heapAfterMB: (await heap(cdp)).heapMB, blobUrlsAfter: held.blobUrls, imgsAfter: held.imgs, errors: errors.slice(0, 3) });
  await page.close();
  return result;
}

const results = { label, cpuSlowdown: CPU, viewport: VIEWPORT, at: new Date().toISOString(), scenarios: {} };
for (const key of only) {
  if (!SCENARIOS[key]) {
    console.log(`unknown scenario ${key}`);
    continue;
  }
  results.scenarios[key] = await measure(key);
}
await browser.close();
const out = opt('--out', null);
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
console.log('\n' + singleTable(results));

function singleTable(r) {
  const rows = Object.values(r.scenarios);
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [
    `**${r.label}** (CPU x${r.cpuSlowdown}, ${r.viewport.width}x${r.viewport.height})`,
    '',
    line(['Book', 'chapters mounted', 'DOM nodes', 'page height', 'JS heap', 'first text', 'fling max gap / p95 / >50ms', 'blank screens', 'traverse']),
    line(['---', '---:', '---:', '---:', '---:', '---:', '---', '---', '---']),
    ...rows.map((s) =>
      line([
        s.title,
        s.chapters,
        s.nodes.toLocaleString('en-US'),
        `${(s.pageHeight / 1e6).toFixed(2)}M px`,
        `${s.heapMB} MB`,
        `${s.firstTextMs} ms`,
        `${s.fling.maxGapMs} ms / ${s.fling.medianP95GapMs} ms / ${s.fling.gapsOver50}`,
        `${s.fling.blankScreens}/${s.fling.screensChecked}`,
        `${s.traverse.travelledMpx}M px, ${s.traverse.blank}/${s.traverse.checks} blank${s.traverse.firstBlankAtY !== null ? ` (from y=${s.traverse.firstBlankAtY.toLocaleString('en-US')})` : ''}`,
      ]),
    ),
  ].join('\n');
}

function comparisonTable(before, after) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  const keys = Object.keys(before.scenarios).filter((k) => after.scenarios[k]);
  const rows = [];
  for (const k of keys) {
    const b = before.scenarios[k];
    const a = after.scenarios[k];
    const m = (v) => `${(v / 1e6).toFixed(2)}M px`;
    rows.push(
      line([`**${b.title}**`, '', '']),
      line(['chapters mounted', b.chapters, a.chapters]),
      line(['DOM nodes', b.nodes.toLocaleString('en-US'), a.nodes.toLocaleString('en-US')]),
      line(['page height (document scroll height)', m(b.pageHeight), m(a.pageHeight)]),
      line(['largest page height seen while flinging', m(b.fling.maxPageHeight), m(a.fling.maxPageHeight)]),
      line(['JS heap after open', `${b.heapMB} MB`, `${a.heapMB} MB`]),
      line(['JS heap after the traverse', `${b.heapAfterMB} MB`, `${a.heapAfterMB} MB`]),
      ...(b.blobUrlsPeak !== undefined ? [line(['blob: URLs alive: at most while reading / at the end (<img> mounted at the end)', `${b.blobUrlsPeak} / ${b.blobUrlsAfter} (${b.imgsAfter})`, `${a.blobUrlsPeak} / ${a.blobUrlsAfter} (${a.imgsAfter})`])] : []),
      line(['time to first text', `${b.firstTextMs} ms`, `${a.firstTextMs} ms`]),
      line(['fling frame gaps: max / median p95 / over 50 ms', `${b.fling.maxGapMs} / ${b.fling.medianP95GapMs} ms / ${b.fling.gapsOver50}`, `${a.fling.maxGapMs} / ${a.fling.medianP95GapMs} ms / ${a.fling.gapsOver50}`]),
      line(['fling: frames stalled waiting for more content', b.fling.stalls, a.fling.stalls]),
      line(['blank screens (fling start/end)', `${b.fling.blankScreens}/${b.fling.screensChecked}`, `${a.fling.blankScreens}/${a.fling.screensChecked}`]),
      line(['continuous traverse: blank checks', `${b.traverse.blank}/${b.traverse.checks}${b.traverse.firstBlankAtY !== null ? ` from y=${b.traverse.firstBlankAtY.toLocaleString('en-US')}` : ''}`, `${a.traverse.blank}/${a.traverse.checks}${a.traverse.firstBlankAtY !== null ? ` from y=${a.traverse.firstBlankAtY.toLocaleString('en-US')}` : ''}`]),
    );
  }
  return [line(['', 'before', 'after']), line(['---', '---:', '---:']), ...rows].join('\n');
}
