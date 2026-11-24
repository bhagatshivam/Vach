#!/usr/bin/env node
// The real LibraryScreen and ReaderScreen (and the real index.css / App.css / frame.css) in headless Chromium,
// at phone sizes and in every theme: asserts that the pixels along all four screen edges are the theme colour
// (no white frame), that #root is full-bleed, that the page background follows the theme, that the reading column
// is unchanged, and that content stays clear of the system-bar insets. Writes screenshots to a folder.
//
//   node scripts/verify/frame-chromium.mjs [screenshot-dir]
//
// Needs Playwright with a Chromium (pre-installed in the Claude Code sandbox).

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(join(repo, 'package.json'));
const shots = resolve(process.argv[2] ?? join(repo, 'node_modules/.cache/vach-bench/frame-shots'));
mkdirSync(shots, { recursive: true });

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.log('SKIPPED: Playwright is not installed here, so there is no headless Chromium to check against.');
  process.exit(0);
}

const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
const outDir = join(repo, 'node_modules/.cache/vach-bench/verify-frame');
const stub = (pattern, file) => ({
  name: `stub-${file}`,
  enforce: 'pre',
  resolveId(source) {
    return pattern.test(source) ? join(here, file) : null;
  },
});
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
const sample = readFileSync(join(repo, 'samples/tables-sample.epub')).toString('base64');

const THEMES = {
  sepia: { settings: { theme: 'sepia' }, bg: [244, 236, 216] },
  beige: { settings: { theme: 'beige' }, bg: [221, 215, 200] },
  night: { settings: { theme: 'night' }, bg: [18, 18, 18] },
  custom: { settings: { theme: 'custom', customBackground: '#1a2a3a', customText: '#e8f0f8' }, bg: [26, 42, 58] },
};
const VIEWPORTS = [
  { name: '360x800', width: 360, height: 800, dpr: 2.75 },
  { name: '412x915', width: 412, height: 915, dpr: 2.75 },
  { name: '780x360', width: 780, height: 360, dpr: 2.75 },
];

const browser = await chromium.launch();
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const rgb = (a) => `rgb(${a.join(', ')})`;

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('http://vach.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"></head><body><div id="root"></div></body></html>' }),
  );
  await page.goto('http://vach.test/');
  await page.addStyleTag({ content: css });
  await page.evaluate((b64) => { window.__sampleEpub = b64; }, sample);
  await page.addScriptTag({ content: script });
  // A phone's edge-to-edge insets (status bar 36 css px, gesture bar 20), plus the same screens with no insets.
  const INSETS = { top: 36, bottom: 20, left: 0, right: 0 };

  for (const [themeName, theme] of Object.entries(THEMES)) {
    for (const screen of ['library-empty', 'library-books', 'reader']) {
      for (const insets of [null, INSETS]) {
        const label = `${vp.name} ${themeName} ${screen}${insets ? ' +insets' : ''}`;
        await page.evaluate(([s, st, ins]) => window.frame.show(s, st, ins), [screen, theme.settings, insets]);
        const m = await page.evaluate(() => window.frame.measure());
        const shot = await page.screenshot({ type: 'png' });
        if (!insets || themeName === 'night' || themeName === 'sepia') writeFileSync(join(shots, `${vp.name}-${themeName}-${screen}${insets ? '-insets' : ''}.png`), shot);
        const edges = await page.evaluate(([png, bg]) => window.frame.edgePixels(png, bg), [shot.toString('base64'), theme.bg]);
        const share = (side) => edges.stats[side].themed / edges.stats[side].total;
        const pct = (side) => `${side} ${(share(side) * 100).toFixed(2)}%`;
        // The old frame was 16-24 css px of near-white on the top, left and right (and bottom), so those edges were 0% theme
        // colour. Now: the top edge is all theme colour; left/right are all theme colour except a full-width 1px header border;
        // the bottom corners (where the side padding was) are all theme colour.
        const ok = share('top') === 1 && share('left') >= 0.99 && share('right') >= 0.99 && share('bottomCorners') === 1;
        record(`${label}: the screen edges are the theme colour (${['top', 'left', 'right', 'bottomCorners'].map(pct).join(', ')})`, ok, ok ? '' : JSON.stringify(edges.other));
        record(`${label}: #root is full-bleed (no padding, no max-width, ${m.rootWidth}px of ${m.innerWidth}px)`, m.rootPadding.every((p) => p === '0px') && m.rootMaxWidth === 'none' && Math.abs(m.rootWidth - m.innerWidth) < 0.5);
        record(`${label}: <html>, <body> and the screen all have the theme background`, m.htmlBackground === rgb(theme.bg) && m.bodyBackground === rgb(theme.bg) && m.screenBackground === rgb(theme.bg), `${m.htmlBackground} / ${m.bodyBackground} / ${m.screenBackground}`);
        record(`${label}: no sideways scroll (${m.scrollWidth} <= ${m.innerWidth})`, m.scrollWidth <= m.innerWidth);
        if (screen === 'reader') {
          const expectedWidth = Math.min(vp.width - 32, 448);
          record(`${label}: reading column unchanged (${m.contentWidth}px wide, expected ${expectedWidth}px)`, Math.abs(m.contentWidth - expectedWidth) < 0.5);
        } else {
          const expectedWidth = Math.min(vp.width, 480);
          record(`${label}: library column is at most 480px and centred (${m.columnWidth}px)`, Math.abs(m.columnWidth - expectedWidth) < 0.5);
        }
        if (insets) {
          // The first piece of text must start below the status bar inset.
          record(`${label}: content clears the status bar (text top ${Math.round(m.firstTextTop)} >= ${insets.top})`, m.firstTextTop >= insets.top, '');
          if (screen === 'reader') record(`${label}: the fixed header starts at the very top, so its background covers the status bar`, Math.abs(m.headerTop) < 0.5);
        }
      }
    }
  }
  record(`${vp.name}: no uncaught page errors`, errors.length === 0, errors.join('; '));
  await page.close();
}

// Control: prove the edge check would catch the old white frame.
{
  const page = await browser.newPage({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2.75 });
  await page.route('http://vach.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div></body></html>' }));
  await page.goto('http://vach.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await page.evaluate((b64) => { window.__sampleEpub = b64; }, sample);
  await page.evaluate(() => window.frame.show('library-empty', { theme: 'night' }, null));
  await page.addStyleTag({ content: '#root{max-width:480px;margin:0 auto;padding:24px 16px}html,body{background:#fdfcfb !important}' });
  await page.evaluate(() => (document.documentElement.style.cssText = 'background:#fdfcfb'));
  const png = (await page.screenshot({ type: 'png' })).toString('base64');
  const edges = await page.evaluate(([p, bg]) => window.frame.edgePixels(p, bg), [png, [18, 18, 18]]);
  const frame = edges.stats.top.themed / edges.stats.top.total;
  record('control: the edge check does flag the old white frame (top edge themed share ' + (frame * 100).toFixed(1) + '%)', frame < 0.5 && edges.stats.left.themed / edges.stats.left.total < 0.5);
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${shots}`);
process.exit(failed.length === 0 ? 0 : 1);
