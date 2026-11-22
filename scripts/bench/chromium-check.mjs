#!/usr/bin/env node
// Verifies, in headless Chromium, that DecompressionStream('deflate-raw'), the
// central-directory reader and both EPUB read paths work in a real browser
// engine, including a ZIP/EPUB with Unicode names and corrupt/truncated data.
//
//   node scripts/bench/chromium-check.mjs [--fixtures <dir>]
//
// Needs Playwright with a Chromium (pre-installed in the Claude Code sandbox;
// elsewhere: npm i -D playwright && npx playwright install chromium).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const argv = process.argv.slice(2);
const fixturesDir = resolve(argv.includes('--fixtures') ? argv[argv.indexOf('--fixtures') + 1] : join(tmpdir(), 'vach-bench'));
const require = createRequire(join(repo, 'package.json'));

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.log('SKIPPED: Playwright is not installed here, so there is no headless Chromium to check against.');
  process.exit(0);
}

// 1. Bundle the in-browser checks into one IIFE.
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const outDir = join(repo, 'node_modules/.cache/vach-bench/browser');
await build({
  root: repo,
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    minify: false,
    lib: { entry: join(here, 'browser-entry.ts'), name: 'vachBenchBundle', formats: ['iife'], fileName: () => 'browser-entry.js' },
  },
});
const bundle = readFileSync(join(outDir, 'browser-entry.js'), 'utf8');

// 2. Fixtures built here (Node) and handed to the page as base64.
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const FIXED = new Date(Date.UTC(2020, 0, 1));

const unicodeEntries = {
  'OEBPS/अध्याय-१.xhtml': '<p>नमस्ते वाच</p>'.repeat(40),
  'OEBPS/日本語/章.xhtml': '<p>日本語のテキスト</p>'.repeat(40),
  'Café ☕ résumé.txt': 'plain text, stored',
  'emoji-😀.txt': 'emoji name',
};
async function unicodeZipBytes() {
  const zip = new JSZip();
  let first = true;
  for (const [name, content] of Object.entries(unicodeEntries)) {
    zip.file(name, content, { compression: first ? 'STORE' : 'DEFLATE', date: FIXED, createFolders: false });
    first = false;
  }
  return zip.generateAsync({ type: 'uint8array' });
}

async function unicodeEpubBytes() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE', date: FIXED });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/内容.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', { date: FIXED });
  const names = ['章一', 'अध्याय', 'Café'];
  const manifest = names.map((n, i) => `<item id="c${i}" href="text/${encodeURIComponent(n)}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const spine = names.map((_, i) => `<itemref idref="c${i}"/>`).join('');
  zip.file('OEBPS/内容.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>यूनिकोड पुस्तक</dc:title></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`, { date: FIXED });
  names.forEach((n, i) => zip.file(`OEBPS/text/${n}.xhtml`, `<html><body><h2>${n}</h2><p>UNICODE_CHAPTER_${i} ${'वाच '.repeat(200)}</p></body></html>`, { date: FIXED, compression: 'DEFLATE' }));
  return zip.generateAsync({ type: 'uint8array' });
}

async function errorFixtures() {
  const payload = new TextEncoder().encode('hello world hello world '.repeat(300));
  const one = async (extra = {}) => {
    const zip = new JSZip();
    zip.file('a.txt', payload, { compression: 'DEFLATE', date: FIXED });
    return zip.generateAsync({ type: 'uint8array', ...extra });
  };
  const good = await one();
  const dataStart = 30 + 'a.txt'.length;

  const garbage = good.slice();
  garbage.fill(0xff, dataStart, dataStart + 8); // invalid deflate block type

  const eocd = good.length - 22;
  const cd = good.length - 22 - (46 + 'a.txt'.length);
  const compressedSize = new DataView(good.buffer, good.byteOffset).getUint32(cd + 20, true);
  const truncated = good.slice();
  new DataView(truncated.buffer).setUint32(cd + 20, Math.floor(compressedSize / 2), true); // reader fetches only half the stream
  void eocd;

  const bomb = new JSZip();
  bomb.file('a.txt', new Uint8Array(4 * 1024 * 1024), { compression: 'DEFLATE', date: FIXED });
  return [
    { name: 'valid', bytes: good, cap: 1 << 24 },
    { name: 'garbage deflate data', bytes: garbage, cap: 1 << 24 },
    { name: 'truncated deflate stream', bytes: truncated, cap: 1 << 24 },
    { name: 'zip bomb over the cap (4 MiB of zeros, cap 1 MiB)', bytes: await bomb.generateAsync({ type: 'uint8array' }), cap: 1 << 20 },
  ].map(({ name, bytes, cap }) => ({ name, base64: b64(bytes), entry: 'a.txt', cap }));
}

const fixtures = JSON.parse(readFileSync(join(fixturesDir, 'fixtures.json'), 'utf8'));

// 3. Run it all in the page.
const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
await page.goto('about:blank');
await page.addScriptTag({ content: bundle });

const report = {};
report.env = await page.evaluate(() => window.vachBench.env());
report.deflateRawRoundTrip = await page.evaluate(() => window.vachBench.deflateRawRoundTrip());

const unicodeZip = await unicodeZipBytes();
report.unicodeZip = await page.evaluate(([data, expected]) => window.vachBench.unicodeZip(data, expected), [b64(unicodeZip), unicodeEntries]);
report.unicodeEpubParity = await page.evaluate((data) => window.vachBench.epubParity(data), b64(await unicodeEpubBytes()));
report.epubC = await page.evaluate((data) => window.vachBench.epubParity(data), b64(readFileSync(fixtures.c.path)));
report.epubA = await page.evaluate((data) => window.vachBench.epubParity(data), b64(readFileSync(fixtures.a.path)));
report.errorCases = await page.evaluate((cases) => window.vachBench.errorCases(cases), await errorFixtures());
await browser.close();

const expectedNames = Object.keys(unicodeEntries).sort();
const checks = [
  ['DecompressionStream exists in this Chromium', report.env.decompressionStream === 'function'],
  ['deflate-raw compress -> decompress round trip', report.deflateRawRoundTrip.equal],
  ['Unicode ZIP: every entry name found, contents correct', report.unicodeZip.mismatches.length === 0 && JSON.stringify(report.unicodeZip.found) === JSON.stringify(expectedNames)],
  ['Unicode-named EPUB: whole-file and ranged paths give the same book', report.unicodeEpubParity.identical && report.unicodeEpubParity.chapters === 3 && report.unicodeEpubParity.title === 'यूनिकोड पुस्तक'],
  ['EPUB-C: whole-file and ranged paths give the same book', report.epubC.identical],
  ['EPUB-A (1,500 chapters): whole-file and ranged paths give the same book', report.epubA.identical],
  ['valid entry reads cleanly', report.errorCases.valid.startsWith('read ')],
  ['garbage deflate data fails with a clear "corrupt" error', /looks corrupt/.test(report.errorCases['garbage deflate data'])],
  ['truncated deflate stream fails (does not silently return partial data)', /looks corrupt/.test(report.errorCases['truncated deflate stream'])],
  ['zip bomb stops at the size cap', /exceeds the 1048576-byte/.test(report.errorCases['zip bomb over the cap (4 MiB of zeros, cap 1 MiB)'])],
  ['no uncaught page errors', consoleErrors.length === 0],
];

console.log(JSON.stringify(report, null, 2));
console.log('\n' + checks.map(([name, ok]) => `${ok ? 'PASS' : 'FAIL'}  ${name}`).join('\n'));
mkdirSync(fixturesDir, { recursive: true });
writeFileSync(join(fixturesDir, 'chromium-check.json'), JSON.stringify({ report, checks: checks.map(([name, ok]) => ({ name, ok })) }, null, 2));
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
