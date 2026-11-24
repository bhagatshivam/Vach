#!/usr/bin/env node
// Loads samples/images-sample.epub through the real sanitizer, the real image pipeline, the real
// reader CSS and the real lightbox in headless Chromium, at phone sizes, and checks:
//   (a) no layout shift while images load        (b) no horizontal overflow at 360/412/780 px
//   (c) decoded sizes never exceed the cap       (d) blob: URLs are revoked when the book closes
//   (e) lightbox pinch / pan / double-tap / swipe-down with synthetic pointer events
//
//   node scripts/verify/images-chromium.mjs
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
const outDir = join(repo, 'node_modules/.cache/vach-bench/verify-images');
await build({
  root: repo,
  configFile: false,
  logLevel: 'warn',
  plugins: [(await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: { outDir, emptyOutDir: true, minify: false, cssCodeSplit: false, lib: { entry: join(here, 'images-entry.ts'), name: 'vachVerifyImages', formats: ['iife'], fileName: () => 'images-entry.js' } },
});
const script = readFileSync(join(outDir, 'images-entry.js'), 'utf8');
const css = readdirSync(outDir)
  .filter((name) => name.endsWith('.css'))
  .map((name) => readFileSync(join(outDir, name), 'utf8'))
  .join('\n');

const sample = readFileSync(join(repo, 'samples/images-sample.epub')).toString('base64');
const browser = await chromium.launch();
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

async function open(width, height, theme = 'sepia') {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  // A real (fake-host) origin: blob: URLs can only be fetched back from a page that has one, and the
  // revocation check below fetches them.
  await page.route('http://vach.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' }));
  await page.goto('http://vach.test/');
  await page.addStyleTag({ content: `html,body{margin:0}${css}` });
  await page.addScriptTag({ content: script });
  const info = await page.evaluate(([data, t]) => window.verify.load(data, t), [sample, theme]);
  return { page, info, errors };
}

const near = (a, b, eps = 1) => Math.abs(a - b) <= eps;

for (const [width, height, label] of [
  [360, 780, '360 px (portrait)'],
  [412, 915, '412 px (portrait)'],
  [780, 360, '780 px (landscape)'],
]) {
  const { page, info, errors } = await open(width, height);
  console.log(`\n== ${label}: ${info.chapters} chapters, ${info.images} images`);

  record(`${label}: every <img> in the page is an own blob: URL (no data: URLs)`, !info.dataUris && info.srcs.every((s) => s.startsWith('blob:')), info.srcs.map((s) => s.slice(0, 20)).join(' '));

  // (a) positions before any image work, then after everything has been processed.
  const before = await page.evaluate(() => window.verify.snapshot());
  const run = await page.evaluate(() => window.verify.processAll());
  const after = await page.evaluate(() => window.verify.snapshot());
  const moved = before.map((b, i) => ({ key: b.key, dTop: Math.abs(b.top - after[i].top), dHeight: Math.abs(b.height - after[i].height) })).filter((m) => m.dTop > 1 || m.dHeight > 1);
  record(`${label}: (a) nothing moved while images were processed (${before.length} blocks compared)`, before.length === after.length && moved.length === 0, JSON.stringify(moved.slice(0, 4)));
  record(`${label}: (a) the browser's own Layout Instability score is ~0 (${run.cls.toFixed(4)})`, run.cls < 0.001);
  record(`${label}: all pending images were processed`, run.stillPending === 0, `${run.stillPending} pending`);

  // (b)
  const o = await page.evaluate(() => window.verify.overflow());
  record(`${label}: (b) no horizontal overflow (scrollWidth ${o.scrollWidth} <= ${o.clientWidth}; page ${o.pageScrollWidth} <= ${o.innerWidth})`, o.ok, o.ok ? '' : `${o.worst}px by <${o.worstTag}>`);

  // (c)
  const report = await page.evaluate(() => window.verify.imageReport());
  const raster = report.images.filter((i) => !i.src.includes('svg'));
  const tooBig = raster.filter((i) => i.natural[0] > report.cap && !i.alt.includes('Vector'));
  record(`${label}: (c) no decoded image wider than the cap (${report.cap}px)`, tooBig.length === 0, JSON.stringify(tooBig.map((i) => [i.alt, i.natural])));
  const huge = report.images.find((i) => i.alt.startsWith('Huge'));
  record(`${label}: (c) the 4000 x 6000 poster decodes at ${huge.natural.join(' x ')} (cap ${report.cap}), proportions kept`, huge.natural[0] === Math.min(report.cap, 4000) && near(huge.natural[1] / huge.natural[0], 1.5, 0.01));
  const tall = report.images.filter((i) => !i.inline).filter((i) => i.shown[1] > report.viewportHeight * 0.82 + 1);
  record(`${label}: no picture taller than 82% of the screen`, tall.length === 0, JSON.stringify(tall.map((i) => [i.alt, i.shown])));
  const stretched = report.images.filter((i) => !i.inline && i.shown[0] > report.contentWidth + 0.5);
  record(`${label}: no picture wider than the text column`, stretched.length === 0);
  const noSize = report.images.find((i) => i.alt.startsWith('Image with no size'));
  record(`${label}: an image with no width/height got its size stamped before it loaded`, Boolean(noSize.attrs[0] && noSize.attrs[1] && noSize.aspect), JSON.stringify([noSize.attrs, noSize.aspect]));
  record(`${label}: images are lazy + async decoded`, report.images.every((i) => i.loading === 'lazy' && i.decoding === 'async'));
  const gif = report.images.find((i) => i.alt === 'Spinning dot');
  record(`${label}: animated GIF passed through untouched (still its own 64 x 64)`, gif.natural[0] === 64 && gif.natural[1] === 64);

  record(`${label}: no uncaught page errors`, errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- night theme --------------------------------------------------------------------------
{
  const { page } = await open(360, 780, 'night');
  await page.evaluate(() => window.verify.processAll());
  const report = await page.evaluate(() => window.verify.imageReport());
  record('night theme: pictures are dimmed (brightness + contrast filter)', report.images.every((i) => /brightness\(0\.84\)/.test(i.filter)), report.images[0].filter);
  await page.close();
}

// ---- (e) lightbox, (d) revocation -------------------------------------------------------------
{
  const { page, errors } = await open(360, 780, 'night');
  await page.evaluate(() => window.verify.processAll());
  const baseUrls = await page.evaluate(() => window.verify.liveUrlCount());

  const opened = await page.evaluate(() => window.verify.openLightbox('Huge flat-colour poster', true));
  const longest = Math.max(...opened.natural);
  record(`lightbox: re-decoded the original from the archive, capped at ${opened.max} px (got ${opened.natural.join(' x ')})`, longest <= opened.max && longest > 1600, '');
  record('lightbox: opens fitted - whole picture visible, centred', opened.rect.left >= -0.5 && opened.rect.right <= 360.5 && opened.rect.top >= -0.5 && opened.rect.bottom <= 780.5 && near(opened.rect.left + opened.rect.width / 2, 180, 1.5), JSON.stringify(opened.rect));
  const fit = opened.scale;
  const cx = 180;
  const cy = 390;

  await page.evaluate(([x, y]) => window.verify.doubleTap(x, y), [cx, cy]);
  let v = await page.evaluate(() => window.verify.lightboxView());
  record(`lightbox: double-tap zooms in (${fit.toFixed(3)} -> ${v.scale.toFixed(3)})`, v.scale > fit * 2);
  await page.evaluate(([x, y]) => window.verify.doubleTap(x, y), [cx, cy]);
  v = await page.evaluate(() => window.verify.lightboxView());
  record('lightbox: double-tap again returns to the fitted size', near(v.scale, fit, fit * 0.02), `${v.scale.toFixed(3)}`);

  await page.evaluate(([x, y]) => window.verify.pinchGesture(x, y, 60, 180), [cx, cy]);
  v = await page.evaluate(() => window.verify.lightboxView());
  record(`lightbox: pinch out zooms in (${fit.toFixed(3)} -> ${v.scale.toFixed(3)}, ~3x)`, v.scale > fit * 2 && v.scale < fit * 4);
  const scaleBeforeSqueeze = v.scale;
  await page.evaluate(([x, y]) => window.verify.pinchGesture(x, y, 240, 20), [cx, cy]);
  v = await page.evaluate(() => window.verify.lightboxView());
  record('lightbox: pinch in never goes smaller than fitted', v.scale >= fit - fit * 0.01 && v.scale < scaleBeforeSqueeze, v.scale.toFixed(3));

  // Zoom in, then pan: moves, and is clamped so the picture always covers the screen.
  await page.evaluate(([x, y]) => window.verify.doubleTap(x, y), [cx, cy]);
  const zoomed = await page.evaluate(() => window.verify.lightboxView());
  await page.evaluate(() => window.verify.drag([200, 400], [120, 330]));
  const panned = await page.evaluate(() => window.verify.lightboxView());
  record('lightbox: dragging pans the zoomed picture', Math.hypot(panned.x - zoomed.x, panned.y - zoomed.y) > 20, `${zoomed.x.toFixed(0)},${zoomed.y.toFixed(0)} -> ${panned.x.toFixed(0)},${panned.y.toFixed(0)}`);
  await page.evaluate(() => window.verify.drag([20, 20], [340, 760], { steps: 20 }));
  await page.evaluate(() => window.verify.drag([20, 20], [340, 760], { steps: 20 }));
  v = await page.evaluate(() => window.verify.lightboxView());
  record('lightbox: pan is clamped (dragged hard to the corner, the picture edge stops at the screen edge)', v.rect.left <= 0.5 && v.rect.top <= 0.5 && v.rect.left > -v.rect.width, JSON.stringify([v.rect.left, v.rect.top]));
  await page.evaluate(() => window.verify.drag([340, 760], [20, 20], { steps: 20 }));
  await page.evaluate(() => window.verify.drag([340, 760], [20, 20], { steps: 20 }));
  v = await page.evaluate(() => window.verify.lightboxView());
  record('lightbox: ...and to the opposite corner', v.rect.right >= 359.5 && v.rect.bottom >= 779.5, JSON.stringify([v.rect.right, v.rect.bottom]));

  // Invert toggle on a dark theme.
  await page.evaluate(() => window.verify.clickInvert());
  const inverted = await page.evaluate(() => window.verify.invertFilter());
  record('lightbox: "Invert" applies for the dark theme', /invert/.test(inverted), inverted);

  // Back to fitted, then swipe down closes.
  await page.evaluate(([x, y]) => window.verify.doubleTap(x, y), [cx, cy]);
  v = await page.evaluate(() => window.verify.lightboxView());
  record('lightbox: double-tap from zoomed goes back to fitted', near(v.scale, fit, fit * 0.02), v.scale.toFixed(3));
  await page.evaluate(() => window.verify.drag([180, 300], [180, 640], { steps: 8, stepMs: 8 }));
  record('lightbox: swipe down (at the fitted size) closes it', !(await page.evaluate(() => window.verify.isOpen())));
  await page.evaluate(() => window.verify.sleep(100));
  record('lightbox: closing frees the full-detail copy (live URLs back to what the page uses)', (await page.evaluate(() => window.verify.liveUrlCount())) === baseUrls, `${await page.evaluate(() => window.verify.liveUrlCount())} vs ${baseUrls}`);

  // A short drag does not close it; a tap on the backdrop does.
  await page.evaluate(() => window.verify.openLightbox('Huge flat-colour poster'));
  await page.evaluate(() => window.verify.drag([180, 300], [180, 330], { steps: 4 }));
  record('lightbox: a short drag does not close it', await page.evaluate(() => window.verify.isOpen()));
  await page.evaluate(() => window.verify.closeLightbox());

  // (d)
  const closed = await page.evaluate(() => window.verify.closeBook());
  record(`(d) blob URLs were loadable while the book was open (${closed.loadableBefore}/${closed.urls})`, closed.loadableBefore > 0);
  record(`(d) after the book closes, none of its ${closed.urls} blob URLs can be loaded and none are live`, closed.loadableAfter === 0 && closed.live === 0, JSON.stringify(closed));
  // Fetching a revoked blob: URL is logged by Chromium as ERR_FILE_NOT_FOUND - that is the check working.
  const unexpected = errors.filter((e) => !/ERR_FILE_NOT_FOUND/.test(e));
  record('no uncaught page errors during the lightbox checks', unexpected.length === 0, unexpected.join('; '));
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
