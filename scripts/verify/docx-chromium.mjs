#!/usr/bin/env node
// Checks, in headless Chromium, what cannot be checked in jsdom: that the Word converter (mammoth) really runs inside
// a Web Worker (no DOM needed) as built by Vite, that bad files give the right error from the worker, and how long
// conversion keeps the main thread busy.
//
//   node scripts/verify/docx-chromium.mjs [path/to/file.docx ...]
//
// Needs Playwright with a Chromium (pre-installed in the Claude Code sandbox).

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
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
const outDir = join(repo, 'node_modules/.cache/vach-bench/verify-docx');
await build({
  root: here,
  configFile: false,
  logLevel: 'warn',
  worker: { format: 'es' },
  build: { outDir, emptyOutDir: true, minify: false, target: 'chrome111', rollupOptions: { input: join(here, 'docx-page.html') } },
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
const browser = await chromium.launch();
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const files = process.argv.slice(2).length > 0 ? process.argv.slice(2).map((f) => resolve(f)) : [join(repo, 'samples/docx-sample.docx'), join(repo, 'samples/docx-no-headings.docx')];

async function open() {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // The same CSP the app ships: a worker is allowed only from the same origin.
  await page.route('http://vach.test/**', (route) => {
    const url = new URL(route.request().url());
    // Documents under test are served as binary at /file/<index>, so memory is not inflated by base64 text.
    if (url.pathname.startsWith('/file/')) return route.fulfill({ contentType: 'application/octet-stream', body: readFileSync(files[Number(url.pathname.slice(6))]) });
    const file = join(outDir, url.pathname === '/' ? 'docx-page.html' : url.pathname);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({
      contentType: MIME[extname(file)] ?? 'application/octet-stream',
      headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:" },
      body: readFileSync(file),
    });
  });
  await page.goto('http://vach.test/');
  await page.waitForFunction(() => Boolean(window.docx));
  return { page, errors };
}

/** Resident memory of every browser process (page, workers, GPU, network...), in MB. Sampled, so the peak is approximate. */
function browserRssMB() {
  try {
    const out = execSync("ps -eo rss=,args= | grep -i -E 'chrom|headless_shell' | grep -v grep | awk '{s+=$1} END {print s+0}'", { encoding: 'utf8' });
    return Math.round(Number(out.trim()) / 1024);
  } catch {
    return 0;
  }
}

const { page, errors } = await open();

for (const file of files) {
  const baseline = browserRssMB();
  let peak = baseline;
  const sampler = setInterval(() => (peak = Math.max(peak, browserRssMB())), 60);
  const r = await page.evaluate((data) => window.docx.convert(data), `/file/${files.indexOf(file)}`);
  clearInterval(sampler);
  peak = Math.max(peak, browserRssMB());
  r.browserMemoryMB = { before: baseline, peak, growth: peak - baseline };
  const label = `${file.split('/').pop()} (${(statSync(file).size / 1e6).toFixed(2)} MB)`;
  console.log(`   ${JSON.stringify(r)}`);
  record(`${label}: mammoth ran inside a Web Worker (no DOM needed)`, r.ranInWorker);
  record(`${label}: converted ${r.htmlBytes.toLocaleString()} bytes of HTML, ${r.images} image(s), ${r.chapters} chapter(s)`, r.htmlBytes > 100 && r.chapters >= 1);
}

// Bad input comes back as the right error from the worker.
const bad = {
  'not a Word file at all': Buffer.from('hello, this is plain text'),
  'a ZIP that is not a Word document': readFileSync(join(repo, 'samples/tables-sample.epub')),
  'an encrypted / legacy OLE file': Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]),
  'a truncated document': readFileSync(join(repo, 'samples/docx-sample.docx')).subarray(0, 1500),
};
const expected = { 'not a Word file at all': 'not-docx', 'a ZIP that is not a Word document': 'not-docx', 'an encrypted / legacy OLE file': 'password-protected', 'a truncated document': 'corrupt' };
for (const [name, bytes] of Object.entries(bad)) {
  const r = await page.evaluate((data) => window.docx.error(data), bytes.toString('base64'));
  record(`${name}: DocxError "${expected[name]}" from the worker, with a readable message`, !r.ok && r.name === 'DocxError' && r.code === expected[name] && r.message.length > 20, JSON.stringify(r));
}
record('no uncaught page errors', errors.length === 0, errors.join('; '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
