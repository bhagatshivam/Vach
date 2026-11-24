#!/usr/bin/env node
// Loads samples/tables-sample.epub through the real sanitizer, the real reader
// CSS and the real table adapter in headless Chromium, at phone widths, and
// checks that nothing overflows sideways - also after font-size changes - and
// that the reading position survives a layout change.
//
//   node scripts/verify/tables-chromium.mjs
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

const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const outDir = join(repo, 'node_modules/.cache/vach-bench/verify');
await build({
  root: repo,
  configFile: false,
  logLevel: 'warn',
  plugins: [(await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: { outDir, emptyOutDir: true, minify: false, cssCodeSplit: false, lib: { entry: join(here, 'page-entry.ts'), name: 'vachVerify', formats: ['iife'], fileName: () => 'page-entry.js' } },
});
const script = readFileSync(join(outDir, 'page-entry.js'), 'utf8');
const css = readdirSync(outDir)
  .filter((name) => name.endsWith('.css'))
  .map((name) => readFileSync(join(outDir, name), 'utf8'))
  .join('\n');

const sample = readFileSync(join(repo, 'samples/tables-sample.epub')).toString('base64');
const browser = await chromium.launch();
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

async function open(width, height, { adapt = true } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('about:blank');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  const info = await page.evaluate(([data, options]) => window.verify.load(data, options), [sample, { adapt }]);
  return { page, info, errors };
}

for (const [width, height, label] of [
  [360, 780, '360 px wide (portrait)'],
  [412, 915, '412 px wide (portrait)'],
  [780, 360, '780 px wide (landscape)'],
]) {
  const { page, info, errors } = await open(width, height);
  console.log(`\n== ${label}: ${info.chapters} chapters, ${info.tables} tables`);
  const modes = await page.evaluate(() => window.verify.modes());
  console.log('   modes:', modes.map((m) => `${m.mode}(${m.columns}c)`).join(' '));

  let o = await page.evaluate(() => window.verify.overflow());
  record(`${label}: no horizontal overflow (scrollWidth ${o.scrollWidth} <= clientWidth ${o.clientWidth}; page ${o.pageScrollWidth} <= ${o.innerWidth})`, o.ok, o.ok ? '' : JSON.stringify(o.worstElementOverflow));

  if (width <= 412) {
    const used = new Set(modes.map((m) => m.mode));
    record(`${label}: the adapter engaged (compact, cards and collapsed all used)`, used.has('compact') && used.has('cards') && used.has('collapsed'), [...used].join(','));
  }

  const blocksBefore = await page.evaluate(() => window.verify.blockCounts());
  for (const fontSize of [28, 14, 18]) {
    await page.evaluate((px) => window.verify.setFontSize(px), fontSize);
    await page.evaluate(() => window.verify.reevaluate());
    o = await page.evaluate(() => window.verify.overflow());
    const m = await page.evaluate(() => window.verify.modes().map((t) => t.mode).join(' '));
    record(`${label}: no overflow after font size -> ${fontSize}px`, o.ok, `${m}${o.ok ? '' : ' ' + JSON.stringify(o.worstElementOverflow)}`);
  }
  const blocksAfter = await page.evaluate(() => window.verify.blockCounts());
  record(`${label}: block structure (reading-position blocks) identical across all those modes`, JSON.stringify(blocksBefore) === JSON.stringify(blocksAfter), blocksAfter.join(','));

  if (width === 360) {
    const grid = await page.evaluate(() => window.verify.openGrid());
    record('360 px: Expand Grid opens the full grid (no reader labels) in the lightbox, wider than the screen', Boolean(grid && grid.widerThanScreen && grid.startsAtLeftEdge && !grid.hasLabels && !/vach-table-(cards|collapsed|compact)/.test(grid.tableClasses)), JSON.stringify(grid));
    record('360 px: ...and the grid pans (clamped to its edge) and pinch-zooms', Boolean(grid && grid.panMoves && grid.panClamped && grid.pinchZooms), '');
    await page.evaluate(() => window.verify.closeGrid());

    const planted = await page.evaluate(() => {
      const remove = window.verify.plantOverflow();
      const detected = !window.verify.overflow().ok;
      remove();
      return detected;
    });
    record('control: the checker does flag a planted 2,000 px element', planted);

    for (const [chapter, px] of [[1, 26], [2, 14]]) {
      const r = await page.evaluate(([c, size]) => window.verify.reanchorCheck(c, size), [chapter, px]);
      record(`360 px: reader stays on the same passage after font size -> ${px}px (chapter ${chapter})`, r.sameBlock, `"${r.textBefore}" -> "${r.textAfter}" ${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)}`);
    }
  }
  record(`${label}: no uncaught page errors`, errors.length === 0, errors.join('; '));
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
