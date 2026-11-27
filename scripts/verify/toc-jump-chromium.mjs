#!/usr/bin/env node
// Jumps through the Contents drawer of synthetic EPUBs in headless Chromium (the real ReaderScreen, CSS, sanitizer
// and TOC code) and checks that after EVERY jump the target chapter is mounted and in view and nothing is blank -
// including a last chapter that is much shorter than the screen.
//
//   node scripts/verify/toc-jump-chromium.mjs
//
// Needs Playwright with a Chromium (pre-installed in the Claude Code sandbox).

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
const JSZip = require('jszip');

// ---- synthetic EPUBs ------------------------------------------------------------------------------------------
const LOREM = 'The caravan reached the ridge at dusk, and from there the whole valley lay open beneath them: the river, the long road, the lamps of the town coming on one by one. ';

/** `chapters` entries: { title, paragraphs } - paragraphs of ordinary length, or a few short lines. */
async function epub(chapters) {
  const zip = new JSZip();
  const fixed = new Date(Date.UTC(2020, 0, 1));
  const add = (path, data, compression = 'DEFLATE') => zip.file(path, data, { compression, date: fixed });
  add('mimetype', 'application/epub+zip', 'STORE');
  add('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'];
  if (chapters.some((c) => c.logo)) {
    // A Standard Ebooks-style logo: SVG with a viewBox and no width/height.
    manifest.push('<item id="logo" href="logo.svg" media-type="image/svg+xml"/>');
    add('OEBPS/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120"><rect width="240" height="120" fill="#333"/><circle cx="60" cy="60" r="40" fill="#e2b23a"/></svg>');
  }
  const spine = [];
  const toc = [];
  chapters.forEach((chapter, i) => {
    manifest.push(`<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i}"/>`);
    toc.push(`<li><a href="c${i}.xhtml">${chapter.title}</a></li>`);
    const logo = chapter.logo ? '<p><img alt="The logo." src="logo.svg"/></p>' : '';
    const body = chapter.short
      ? `<p>${chapter.short}</p>${logo}`
      : Array.from({ length: chapter.paragraphs ?? 14 }, () => `<p>${chapter.text ?? LOREM.repeat(3)}</p>`).join('');
    add(`OEBPS/c${i}.xhtml`, `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapter.title}</title></head><body><h2>${chapter.title} MARK_${i}</h2>${body}</body></html>`);
  });
  add('OEBPS/nav.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${toc.join('')}</ol></nav></body></html>`);
  add('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:test</dc:identifier><dc:title>Jump Test</dc:title><dc:language>en</dc:language></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })).toString('base64');
}

// A book so tall that its last chapters sit past 2^23 (8.4 million) CSS px of scroll offset, where Chromium paints nothing.
// Few, very long paragraphs keep the DOM small while the page gets that tall.
const TALL = { chapters: 150, paragraphsPerChapter: 15, charsPerParagraph: 6000 };
async function tallEpub() {
  const long = (LOREM.repeat(Math.ceil(TALL.charsPerParagraph / LOREM.length))).slice(0, TALL.charsPerParagraph);
  const chapters = Array.from({ length: TALL.chapters }, (_, i) =>
    i >= TALL.chapters - 3 ? BACK_MATTER[i - (TALL.chapters - 3)] : { title: `Chapter ${i + 1}`, paragraphs: TALL.paragraphsPerChapter, text: long },
  );
  return epub(chapters);
}

const BACK_MATTER = [
  { title: 'Endnotes', short: 'Note 1. See above. Note 2. Ibid.' },
  { title: 'Colophon', short: 'Set in Sorts Mill Goudy.' },
  { title: 'Uncopyright', short: 'Public domain.' },
];
// Standard Ebooks back matter: very short pages, each with a small SVG logo.
const SE_BACK = [
  { title: 'Endnotes', short: 'Note 1. See above. Note 2. Ibid.' },
  { title: 'Colophon', short: 'Set in Sorts Mill Goudy.', logo: true },
  { title: 'Uncopyright', short: 'Public domain.', logo: true },
];
const named = (n) => Array.from({ length: n }, (_, i) => ({ title: `Chapter ${i + 1}`, paragraphs: 8 + (i % 7) }));

const TALL_NAME = 'very tall book: 150 chapters, 10.7M px as a whole';
const BOOKS = {
  [TALL_NAME]: await tallEpub(),
  'reopened mid-book at a saved position (Standard Ebooks-like, 365 chapters)': await epub([...named(362), ...SE_BACK]),
  'Standard Ebooks-like: 365 chapters, short back matter with SVG logos': await epub([...named(362), ...SE_BACK]),
  'long book, last 3 very short (400 chapters; jumps happen while it is still streaming in)': await epub([...named(397), ...BACK_MATTER]),
  'last 3 chapters very short (60 chapters)': await epub([...named(57), ...BACK_MATTER]),
  'only the final chapter short (60 chapters)': await epub([...named(59), BACK_MATTER[2]]),
  'a single chapter': await epub([{ title: 'Only', short: 'One short page.' }]),
  'every chapter short (12 chapters)': await epub(Array.from({ length: 12 }, (_, i) => ({ title: `Page ${i + 1}`, short: `Short page ${i + 1}.` }))),
};
const TITLES = {
  [TALL_NAME]: { tall: true, streamedMarker: 149, first: 'Chapter 1', middle: 'Chapter 75', secondLast: 'Colophon', last: 'Uncopyright', markers: { 'Chapter 1': 0, 'Chapter 75': 74, Colophon: 148, Uncopyright: 149, Endnotes: 147 } },
  'reopened mid-book at a saved position (Standard Ebooks-like, 365 chapters)': { opensAt: 150, first: 'Chapter 1', middle: 'Chapter 180', secondLast: 'Colophon', last: 'Uncopyright', markers: { 'Chapter 1': 0, 'Chapter 180': 179, Colophon: 363, Uncopyright: 364, Endnotes: 362 } },
  'Standard Ebooks-like: 365 chapters, short back matter with SVG logos': { first: 'Chapter 1', middle: 'Chapter 180', secondLast: 'Colophon', last: 'Uncopyright', markers: { 'Chapter 1': 0, 'Chapter 180': 179, Colophon: 363, Uncopyright: 364, Endnotes: 362 } },
  'long book, last 3 very short (400 chapters; jumps happen while it is still streaming in)': { first: 'Chapter 1', middle: 'Chapter 200', secondLast: 'Colophon', last: 'Uncopyright', markers: { 'Chapter 1': 0, 'Chapter 200': 199, Colophon: 398, Uncopyright: 399, Endnotes: 397 } },
  'last 3 chapters very short (60 chapters)': { first: 'Chapter 1', middle: 'Chapter 30', secondLast: 'Colophon', last: 'Uncopyright', markers: { 'Chapter 1': 0, 'Chapter 30': 29, Colophon: 58, Uncopyright: 59, Endnotes: 57 } },
  'only the final chapter short (60 chapters)': { first: 'Chapter 1', middle: 'Chapter 30', secondLast: 'Chapter 59', last: 'Uncopyright', markers: { 'Chapter 1': 0, 'Chapter 30': 29, 'Chapter 59': 58, Uncopyright: 59 } },
  'every chapter short (12 chapters)': { first: 'Page 1', middle: 'Page 6', secondLast: 'Page 11', last: 'Page 12', markers: { 'Page 1': 0, 'Page 6': 5, 'Page 11': 10, 'Page 12': 11 } },
};

// ---- build the page bundle (same stubs as frame-chromium.mjs) ------------------------------------------------------
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
const outDir = join(repo, 'node_modules/.cache/vach-bench/verify-tocjump');
const stub = (pattern, file) => ({ name: `stub-${file}`, enforce: 'pre', resolveId: (source) => (pattern.test(source) ? join(here, file) : null) });
await build({
  root: repo,
  configFile: false,
  logLevel: 'warn',
  plugins: [stub(/(^|\/)epubFile(\.ts)?$/, 'epubFileStub.ts'), stub(/(^|\/)libraryFolder(\.ts)?$/, 'libraryFolderStub.ts'), stub(/(^|\/)pdf(\.ts)?$/, 'pdfStub.ts'), react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: { outDir, emptyOutDir: true, minify: false, cssCodeSplit: false, lib: { entry: join(here, 'frame-entry.tsx'), name: 'vachFrame', formats: ['iife'], fileName: () => 'frame-entry.js' } },
});
const script = readFileSync(join(outDir, 'frame-entry.js'), 'utf8');
const css = readdirSync(outDir).filter((n) => n.endsWith('.css')).map((n) => readFileSync(join(outDir, n), 'utf8')).join('\n');

const browser = await chromium.launch();
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

async function openBook(base64, viewport, streamDelayMs = 0) {
  // A phone: touch, mobile viewport rules (like Android Chrome / WebView), and a slowed CPU.
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU_SLOWDOWN ?? 4) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('http://vach.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"></head><body><div id="root"></div></body></html>' }));
  await page.goto('http://vach.test/');
  await page.addStyleTag({ content: css });
  await page.evaluate(([b64, delay]) => { window.__sampleEpub = b64; window.__streamDelayMs = delay; }, [base64, streamDelayMs]);
  await page.addScriptTag({ content: script });
  return { page, errors };
}

/** Is `marker` mounted, on screen, and is the screen not blank? */
function judge(state, marker) {
  const onScreen = state.visible.some((v) => v.marker === String(marker));
  const [first, last] = state.mounted;
  const mounted = marker >= first && marker <= last;
  // Blank = nothing of the book on screen. (A short last chapter at the very end of the page leaves empty space below it; that is the end of the book, not a blank screen.)
  const blank = state.visible.length === 0 || state.coveredShare === 0 || (state.ink !== undefined && state.ink < 0.002);
  return { ok: mounted && onScreen && !blank && state.contentVisibility === 'visible' && !state.overlay && !state.drawer, onScreen, mounted, blank };
}

// Each book is opened twice: with chapters streaming in instantly (a jump finds the chapter already mounted), and slowly
// (like a phone: the chapter is not mounted yet, so the jump reopens the window at it).
const SPEEDS = [['fast stream', 0], ['slow stream', 25]];
const VIEWPORTS = [{ width: 360, height: 800 }, { width: 412, height: 915 }, { width: 780, height: 360 }];
for (const [name, base64] of Object.entries(BOOKS)) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) continue; // e.g. ONLY=tall
  const titles = TITLES[name];
  for (const [speedName, delay] of SPEEDS) for (const viewport of VIEWPORTS) {
    // The tall book is heavy: one run, phone-sized, streaming instantly so the whole book is mounted when the jumps start.
    if (titles?.tall && (delay > 0 || viewport.width !== 360)) continue;
    const label = `${name} [${speedName}] @ ${viewport.width}x${viewport.height}`;
    const { page, errors } = await openBook(base64, viewport, delay);
    await page.evaluate(([saved]) => window.frame.show('reader', { theme: 'sepia' }, null, saved ?? undefined), [titles?.opensAt ?? null]);
    if (!titles) {
      // A single chapter: no Contents button (there is nothing to choose), and the page is simply readable.
      const hasButton = await page.evaluate(() => Boolean(document.querySelector('button[aria-label="Contents"]')));
      const s = await page.evaluate(() => window.frame.screen());
      record(`${label}: no Contents button, chapter on screen`, !hasButton && s.visible.length === 1 && s.coveredShare > 0, JSON.stringify(s));
      await page.close();
      continue;
    }
    if (titles.tall) {
      // Only a window of the book is mounted (mountWindow.ts), so the page is short however long the book is, and no chapter
      // sits past 2^23 px: a jump to a far chapter reopens the window at it.
      await page.waitForTimeout(1500);
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      record(`${label}: only a window of the book is mounted: the page is under 1.5M px, not 10.7M (${(h / 1e6).toFixed(2)}M px)`, h < 1_500_000);
    }
    // Opening on the book itself (chapter 1) must be fine too.
    const start = await page.evaluate(() => window.frame.screen());
    const openMarker = titles.opensAt ?? 0;
    record(`${label}: opens on the right chapter and is not blank`, start.visible.length > 0 && (titles.opensAt === undefined || start.visible.some((v) => Number(v.marker) === openMarker)), JSON.stringify(start.visible));

    const plan = [
      ['last (from the start)', titles.last],
      ['first', titles.first],
      ['middle', titles.middle],
      ['last (from the middle)', titles.last],
      ['second to last', titles.secondLast],
      ['last (from second to last)', titles.last],
      ['first (from the last)', titles.first],
    ];
    for (const [step, title] of plan) {
      const state = await page.evaluate((t) => window.frame.jumpTo(t), title);
      if (state.error) {
        record(`${label}: jump to ${step}`, false, state.error);
        continue;
      }
      // What is actually painted, not just what the DOM says: count pixels that differ from the page colour.
      const shot = await page.screenshot({ type: 'png' });
      state.ink = await page.evaluate(async (png) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let ink = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 244) + Math.abs(d[i + 1] - 236) + Math.abs(d[i + 2] - 216) > 40) ink++;
        return ink / (d.length / 4);
      }, shot.toString('base64'));
      const verdict = judge(state, titles.markers[title]);
      record(`${label}: jump to ${step} ("${title}") - chapter mounted and in view, nothing blank`, verdict.ok, verdict.ok ? `mounted ${state.mounted.join('..')}, scrollY ${state.scrollY}/${state.scrollHeight}` : JSON.stringify({ state, verdict }));

      if (title === titles.last) {
        // The reader must be able to scroll back up from the last chapter: earlier chapters get loaded.
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(500);
        const up = await page.evaluate(() => window.frame.screen());
        const earlier = up.mounted[0] < titles.markers[title];
        const ok = earlier || titles.markers[title] === 0;
        record(`${label}: scrolling up from "${title}" has earlier chapters to scroll into (first mounted ${up.mounted[0]})`, ok, JSON.stringify(up));
        // ...and that fills the screen when the last chapter is shorter than it.
        const filled = up.coveredShare >= 0.95 || up.scrollHeight > up.innerHeight;
        record(`${label}: the screen is filled after the neighbours load (covered ${up.coveredShare})`, filled);
      }
    }
    record(`${label}: no uncaught page errors`, errors.length === 0, errors.join('; '));
    await page.close();
  }
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
