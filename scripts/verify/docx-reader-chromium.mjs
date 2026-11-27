#!/usr/bin/env node
// The two sample Word documents through the REAL reader (ReaderScreen, App.css, the sanitizer, table adapter, image
// store, Contents drawer) in headless Chromium: layout, tables, pictures and the lightbox, the Contents drawer and
// jumps (checked on painted pixels), footnote and cross-reference links, a saved position, and the library badge.
//
//   node scripts/verify/docx-reader-chromium.mjs
//
// The Word converter runs on the main thread here (the page bundle has no Worker); docx-chromium.mjs covers the Worker.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
const outDir = join(repo, 'node_modules/.cache/vach-bench/verify-docxreader');
const stub = (pattern, file) => ({ name: `stub-${file}`, enforce: 'pre', resolveId: (source) => (pattern.test(source) ? join(here, file) : null) });
await build({
  root: repo,
  configFile: false,
  logLevel: 'warn',
  plugins: [stub(/(^|\/)epubFile(\.ts)?$/, 'epubFileStub.ts'), stub(/(^|\/)docxFile(\.ts)?$/, 'docxFileStub.ts'), stub(/(^|\/)libraryFolder(\.ts)?$/, 'libraryFolderStub.ts'), stub(/(^|\/)pdf(\.ts)?$/, 'pdfStub.ts'), react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: { outDir, emptyOutDir: true, minify: false, cssCodeSplit: false, lib: { entry: join(here, 'frame-entry.tsx'), name: 'vachFrame', formats: ['iife'], fileName: () => 'frame-entry.js' } },
});
const script = readFileSync(join(outDir, 'frame-entry.js'), 'utf8');
const css = readdirSync(outDir).filter((n) => n.endsWith('.css')).map((n) => readFileSync(join(outDir, n), 'utf8')).join('\n');

const SAMPLE = readFileSync(process.env.DOCX_SAMPLE ?? join(repo, 'samples/docx-sample.docx')).toString('base64');
const NO_HEADINGS = readFileSync(join(repo, 'samples/docx-no-headings.docx')).toString('base64');

const browser = await chromium.launch();
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

async function open(viewport, docxBase64) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('http://vach.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"></head><body><div id="root"></div></body></html>' }));
  await page.goto('http://vach.test/');
  await page.addStyleTag({ content: css });
  await page.evaluate((b64) => { window.__sampleDocx = b64; window.__sampleEpub = ''; }, docxBase64);
  await page.addScriptTag({ content: script });
  return { page, errors };
}

/** The share of the screen that is not the page colour: a blank screen has none. */
async function ink(page, [r, g, b]) {
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
  }, [shot.toString('base64'), [r, g, b]]);
}

const THEMES = { sepia: { settings: { theme: 'sepia' }, bg: [244, 236, 216] }, night: { settings: { theme: 'night' }, bg: [18, 18, 18] } };
const VIEWPORTS = [{ width: 360, height: 800 }, { width: 412, height: 915 }, { width: 780, height: 360 }];
const EXPECTED_TOC = ['Vach DOCX Sample', 'Part One: Headings and text', 'Chapter One: Lists', 'A third-level heading', 'Chapter Two: Tables', 'Part Two: Pictures and back matter', 'Chapter Three: A picture', 'Chapter Four: The end'];

// ---- the library --------------------------------------------------------------------------------------------------------
{
  const { page, errors } = await open({ width: 360, height: 800 }, SAMPLE);
  await page.evaluate(() => window.frame.show('library-books', { theme: 'sepia' }, null));
  const badges = await page.evaluate(() => Array.from(document.querySelectorAll('.book-row')).map((row) => [row.querySelector('.book-title')?.textContent, row.querySelector('.fmt-badge')?.className, row.querySelector('.fmt-badge')?.textContent]));
  const docx = badges.find((b) => b[0] === 'Meeting Notes');
  record('library: a .docx shows a DOCX badge with its own style', Boolean(docx && docx[1] === 'fmt-badge docx' && docx[2] === 'DOCX'), JSON.stringify(docx));
  record('library: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- the sample document ----------------------------------------------------------------------------------------------------
for (const viewport of VIEWPORTS) {
  for (const [themeName, theme] of Object.entries(THEMES)) {
    const label = `docx-sample @ ${viewport.width}x${viewport.height} ${themeName}`;
    const { page, errors } = await open(viewport, SAMPLE);
    await page.evaluate(([st]) => window.frame.show('reader', st, null, undefined, 'sample.docx'), [theme.settings]);
    await page.evaluate(() => window.frame.scrollThrough());
    const facts = await page.evaluate(() => window.frame.contentFacts());
    const first = await page.evaluate(() => window.frame.screen());
    record(`${label}: opens, with the document's own title in the header`, first.visible.length > 0 && facts.title === 'Vach DOCX Sample', JSON.stringify({ title: facts.title, visible: first.visible.length }));
    record(`${label}: no horizontal overflow (${facts.overflow}px)`, facts.overflow <= 0);
    record(`${label}: paints text, not a blank page`, (await ink(page, theme.bg)) > 0.01);

    // Tables: the nine-column one adapts to the screen; merged cells survive.
    if (viewport.width === 360) {
      const modes = facts.tables.map((t) => t.mode);
      const wide = facts.tables.find((t) => t.cols === 9);
      record(`${label}: the 9-column table adapted to the screen (${wide?.mode})`, Boolean(wide) && ['cards', 'collapsed', 'compact'].includes(wide.mode), JSON.stringify(modes));
    }
    record(`${label}: the merged-cell table kept its colspan/rowspan`, facts.tables.some((t) => t.spans >= 2));

    // The picture: sized before it loads, never stretched, and a tap opens the lightbox.
    const img = facts.images[0];
    record(`${label}: the picture has width/height and an aspect-ratio stamped (${img?.width}x${img?.height}, ${img?.aspect}) and loads at its real size`, Boolean(img) && img.width === '600' && img.height === '400' && /600 \/ 400/.test(img.aspect) && img.natural[0] > 0);
    if (themeName === 'sepia') {
      const opened = await page.evaluate(() => window.frame.tapImage());
      record(`${label}: tapping the picture opens the lightbox`, opened);
    }
    record(`${label}: no uncaught page errors`, errors.length === 0, errors.join('; '));
    await page.close();
  }
}

// ---- the Contents drawer, jumps and links (phone-sized, sepia) -----------------------------------------------------------
{
  const { page, errors } = await open({ width: 360, height: 800 }, SAMPLE);
  await page.evaluate(() => window.frame.show('reader', { theme: 'sepia' }, null, undefined, 'sample.docx'));
  await page.evaluate(() => window.frame.openToc());
  // Three levels deep, so groups below the top level start collapsed: expand them all.
  await page.evaluate(() => document.querySelectorAll('.toc-toggle[aria-expanded="false"]').forEach((b) => b.click()));
  const entries = await page.evaluate(() => Array.from(document.querySelectorAll('.toc-item')).map((b) => b.textContent));
  record('Contents: lists the headings (nested), starting with the text before the first heading', JSON.stringify(entries) === JSON.stringify(EXPECTED_TOC), JSON.stringify(entries));
  const depths = await page.evaluate(() => Array.from(document.querySelectorAll('.toc-row')).map((r) => r.style.paddingLeft));
  record('Contents: Part > Chapter > third-level heading are indented by depth', depths[1] === '16px' && depths[2] === '32px' && depths[3] === '48px', JSON.stringify(depths));
  await page.evaluate(() => document.querySelector('.toc-backdrop')?.click());

  for (const title of ['Chapter Four: The end', 'Part One: Headings and text', 'A third-level heading', 'Chapter Three: A picture', 'Vach DOCX Sample', 'Chapter Four: The end']) {
    const state = await page.evaluate((t) => window.frame.jumpTo(t), title);
    const painted = await ink(page, THEMES.sepia.bg);
    record(`Contents: jump to "${title}" lands with content on screen and painted`, !state.error && state.visible.length > 0 && !state.overlay && !state.drawer && painted > 0.003, state.error ?? `visible ${state.visible.map((v) => v.marker).join(',')} painted ${painted.toFixed(3)}`);
  }

  // Links: a footnote number goes to the note, the note's arrow comes back; an endnote; a cross-reference.
  await page.evaluate(() => window.frame.jumpTo('Part One: Headings and text'));
  const facts = await page.evaluate(() => window.frame.contentFacts());
  record('links: the footnote, endnote and cross-reference links are mounted and tappable', facts.links >= 3, `links ${facts.links}`);
  const toNote = await page.evaluate(() => window.frame.clickLink('footnote-2'));
  record('links: tapping the footnote number lands on the footnote', toNote.found && toNote.inView, JSON.stringify(toNote));
  const back = await page.evaluate(() => window.frame.clickLink('footnote-ref-2'));
  record('links: the footnote’s arrow returns to the sentence', back.found && back.inView, JSON.stringify(back));
  const toEnd = await page.evaluate(() => window.frame.clickLink('endnote-3'));
  record('links: tapping the endnote number lands on the endnote', toEnd.found && toEnd.inView, JSON.stringify(toEnd));
  const toBookmark = await page.evaluate(() => window.frame.clickLink('endnote-ref-3'));
  record('links: the endnote’s arrow returns', toBookmark.found && toBookmark.inView, JSON.stringify(toBookmark));
  const xref = await page.evaluate(() => window.frame.clickLink('table_section'));
  record('links: a cross-reference to a bookmark in a later chapter lands on it', xref.found && xref.inView, JSON.stringify(xref));
  record('Contents/links: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- a saved position ----------------------------------------------------------------------------------------------------------
{
  const { page, errors } = await open({ width: 360, height: 800 }, SAMPLE);
  await page.evaluate(() => window.frame.show('reader', { theme: 'sepia' }, null, 4, 'sample.docx'));
  const state = await page.evaluate(() => window.frame.screen());
  record('saved position: reopening at section 4 shows "Part Two", not the start of the document', state.visible.some((v) => /^Part Two/.test(v.text)) && !state.overlay, JSON.stringify(state.visible));
  // The sample is shorter than a few screens, so the sections above the reader are within the mounted window (the window
  // keeps about five screens of text above and below the reader): they are mounted because they are that close. What matters
  // is that a LONG document is not mounted from its start to get to a saved position: checked below on the 100,000-word one.
  record('saved position: the sections above the reader are mounted only because they are within a few screens of it', await page.evaluate(() => document.documentElement.scrollHeight < 6 * window.innerHeight * 2));
  record('saved position: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- a saved position deep in a long document -----------------------------------------------------------------------------------
const BIG_DOCX = join(repo, 'node_modules/.cache/vach-bench/docx/words-100k.docx');
if (existsSync(BIG_DOCX)) {
  const { page, errors } = await open({ width: 360, height: 800 }, readFileSync(BIG_DOCX).toString('base64'));
  await page.evaluate(() => window.frame.show('reader', { theme: 'sepia' }, null, undefined, 'big.docx'));
  const firstText = await page.evaluate(() => (document.querySelector('.reader-content .chapter')?.textContent ?? '').slice(0, 60));
  await page.evaluate(() => window.frame.show('reader', { theme: 'sepia' }, null, 20, 'big.docx'));
  await page.waitForTimeout(1500);
  const deep = await page.evaluate((first) => ({ sections: document.querySelectorAll('.reader-content .chapter').length, hasFirst: Array.from(document.querySelectorAll('.reader-content .chapter')).some((c) => (c.textContent ?? '').startsWith(first)), height: document.documentElement.scrollHeight, overlay: Boolean(document.querySelector('.restore-overlay')) }), firstText);
  record(`saved position deep in a 100,000-word document: opens at section 20 with only a window of the document mounted (${deep.sections} sections, ${(deep.height / 1e3).toFixed(0)}k px), not the sections before it`, !deep.overlay && !deep.hasFirst && deep.sections <= 10, JSON.stringify(deep));
  record('saved position deep in a long document: no uncaught page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- the document with no headings --------------------------------------------------------------------------------------------
for (const viewport of VIEWPORTS.slice(0, 2)) {
  const label = `docx-no-headings @ ${viewport.width}x${viewport.height}`;
  const { page, errors } = await open(viewport, NO_HEADINGS);
  await page.evaluate(() => window.frame.show('reader', { theme: 'sepia' }, null, undefined, 'plain.docx'));
  await page.evaluate(() => window.frame.openToc());
  const entries = await page.evaluate(() => Array.from(document.querySelectorAll('.toc-item')).map((b) => b.textContent));
  record(`${label}: Contents lists "Section 1..N" (${entries.length} sections)`, entries.length >= 6 && entries.every((e, i) => e === `Section ${i + 1}`), JSON.stringify(entries));
  await page.evaluate(() => document.querySelector('.toc-backdrop')?.click());
  const last = entries[entries.length - 1];
  const state = await page.evaluate((t) => window.frame.jumpTo(t), last);
  const painted = await ink(page, THEMES.sepia.bg);
  record(`${label}: jump to "${last}" lands with text on screen`, !state.error && state.visible.length > 0 && painted > 0.01, state.error ?? `painted ${painted.toFixed(3)}`);
  const facts = await page.evaluate(() => window.frame.contentFacts());
  record(`${label}: no horizontal overflow, title from the file name or core.xml (${facts.title})`, facts.overflow <= 0 && Boolean(facts.title));
  record(`${label}: no uncaught page errors`, errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- an optional big document (DOCX_BIG=path): the reader on a 100,000-word file, jumping through the Contents -------------
if (process.env.DOCX_BIG) {
  const big = readFileSync(process.env.DOCX_BIG).toString('base64');
  for (const viewport of VIEWPORTS.slice(0, 2)) {
    const label = `${process.env.DOCX_BIG.split('/').pop()} @ ${viewport.width}x${viewport.height}`;
    const { page, errors } = await open(viewport, big);
    const t0 = Date.now();
    await page.evaluate(() => window.frame.show('reader', { theme: 'sepia' }, null, undefined, 'big.docx'));
    const openMs = Date.now() - t0;
    await page.waitForFunction(() => !document.querySelector('.loading-more'), null, { timeout: 120000 });
    const streamedMs = Date.now() - t0;
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    console.log(`   opened in ${openMs} ms, whole document mounted after ${streamedMs} ms, page height ${(height / 1e6).toFixed(2)}M px`);
    await page.evaluate(() => window.frame.openToc());
    const entries = await page.evaluate(() => { document.querySelectorAll('.toc-toggle[aria-expanded="false"]').forEach((b) => b.click()); return Array.from(document.querySelectorAll('.toc-item')).map((b) => b.textContent); });
    await page.evaluate(() => document.querySelector('.toc-backdrop')?.click());
    record(`${label}: the Contents has ${entries.length} entries`, entries.length >= 20);
    const plan = [entries.at(-1), entries[0], entries[Math.floor(entries.length / 2)], entries.at(-1), entries.at(-2), entries.at(-1)];
    for (const title of plan) {
      const t = Date.now();
      const state = await page.evaluate((x) => window.frame.jumpTo(x), title);
      const painted = await ink(page, THEMES.sepia.bg);
      record(`${label}: jump to "${title}" shows painted text (${Date.now() - t} ms incl. 0.7 s settle)`, !state.error && state.visible.length > 0 && painted > 0.003, state.error ?? `painted ${painted.toFixed(3)}, mounted ${state.mounted.join('..')}`);
    }
    record(`${label}: no uncaught page errors`, errors.length === 0, errors.join('; '));
    await page.close();
  }
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
