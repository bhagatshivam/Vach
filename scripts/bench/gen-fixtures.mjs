#!/usr/bin/env node
// Deterministic synthetic EPUB generator for the Phase 1b benchmarks.
//
//   node scripts/bench/gen-fixtures.mjs [--out <dir>] [--big]
//
// Writes epub-a.epub, epub-b.epub, epub-c.epub (and with --big, epub-d100.epub
// and epub-d300.epub) plus fixtures.json into <dir> (default: a "vach-bench"
// folder under the OS temp directory). Same arguments => byte-identical files.
// Nothing here is ever committed: generated books live outside the repo.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const outDir = resolve(argValue('--out', join(tmpdir(), 'vach-bench')));
const withBig = args.includes('--big');

// ---------------------------------------------------------------------------
// Seeded randomness and text
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ['ka', 'ri', 'mo', 'ten', 'sha', 'lu', 'dor', 'vi', 'an', 'el', 'th', 'or', 'ge', 'na', 'ys', 'qui', 'bar', 'fen', 'ul', 'ma', 'ze', 'ko', 'ra', 'in', 'pel', 'dun', 'ha', 'ro', 'wy', 'os'];
const FUNCTION_WORDS = ['the', 'and', 'of', 'to', 'a', 'in', 'he', 'she', 'it', 'was', 'that', 'with', 'his', 'her', 'for', 'as', 'had', 'but', 'not', 'on', 'they', 'at', 'said', 'would', 'from'];

function makeVocabulary(rand, size) {
  const words = [];
  for (let i = 0; i < size; i++) {
    const n = 1 + Math.floor(rand() * 3);
    let w = '';
    for (let j = 0; j < n; j++) w += SYLLABLES[Math.floor(rand() * SYLLABLES.length)];
    words.push(w);
  }
  return words;
}

// Zipf-ish pick: low indexes are far more common, like real prose (this is what
// makes deflate behave like it does on real chapters, ~2.5x on text).
function pickWord(rand, vocabulary) {
  if (rand() < 0.4) return FUNCTION_WORDS[Math.floor(rand() * FUNCTION_WORDS.length)];
  const r = rand();
  return vocabulary[Math.floor(r * r * r * vocabulary.length)];
}

function paragraph(rand, vocabulary, words) {
  const out = [];
  let sentenceLeft = 6 + Math.floor(rand() * 14);
  let capitalize = true;
  for (let i = 0; i < words; i++) {
    let w = pickWord(rand, vocabulary);
    if (capitalize) w = w[0].toUpperCase() + w.slice(1);
    capitalize = false;
    sentenceLeft--;
    if (sentenceLeft === 0) {
      w += rand() < 0.15 ? '!' : rand() < 0.1 ? '?' : '.';
      sentenceLeft = 6 + Math.floor(rand() * 14);
      capitalize = true;
    }
    out.push(w);
  }
  return out.join(' ') + '.';
}

function chapterBody(rand, vocabulary, words) {
  const paragraphs = [];
  let left = words;
  while (left > 0) {
    const n = Math.min(left, 20 + Math.floor(rand() * 90));
    paragraphs.push(`<p>${paragraph(rand, vocabulary, n)}</p>`);
    left -= n;
  }
  return paragraphs.join('\n');
}

// A pool of incompressible bytes; "images" are windows into it (STORE-d, never decoded).
function makePool(rand, bytes) {
  const pool = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 4) {
    const v = Math.floor(rand() * 4294967296);
    pool[i] = v & 0xff;
    pool[i + 1] = (v >>> 8) & 0xff;
    pool[i + 2] = (v >>> 16) & 0xff;
    pool[i + 3] = (v >>> 24) & 0xff;
  }
  return pool;
}

function fakeJpeg(pool, rand, size) {
  const out = new Uint8Array(size);
  const offset = Math.floor(rand() * (pool.length - size));
  out.set(pool.subarray(offset, offset + size));
  out.set([0xff, 0xd8, 0xff, 0xe0], 0); // JPEG magic; the rest is noise
  return out;
}

// ---------------------------------------------------------------------------
// EPUB assembly
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date(Date.UTC(2020, 0, 1));

async function buildEpub({ name, seed, chapters, wordsPerChapter, imageBytes = 0, imagesEvery = 1, coverBytes = 0 }) {
  const rand = mulberry32(seed);
  const vocabulary = makeVocabulary(rand, 4000);
  const pool = imageBytes || coverBytes ? makePool(rand, Math.max(imageBytes, coverBytes) * 4 + 1024) : null;

  const zip = new JSZip();
  const file = (path, data, compression = 'DEFLATE') =>
    zip.file(path, data, { compression, date: FIXED_DATE, createFolders: false, unixPermissions: 0o644 });

  file('mimetype', 'application/epub+zip', 'STORE');
  file(
    'META-INF/container.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  file('OEBPS/style.css', 'body { margin: 0; } p { text-indent: 1.5em; margin: 0; } h2 { text-align: center; }');

  const manifest = [
    '<item id="css" href="style.css" media-type="text/css"/>',
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
  ];
  const spine = [];
  const navItems = [];
  const imageFiles = [];

  if (coverBytes) {
    manifest.push('<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>');
    imageFiles.push(['OEBPS/images/cover.jpg', fakeJpeg(pool, rand, coverBytes)]);
  }

  for (let i = 0; i < chapters; i++) {
    const title = `Chapter ${i + 1}: ${pickWord(rand, vocabulary)} ${pickWord(rand, vocabulary)}`;
    const hasImage = imageBytes > 0 && i % imagesEvery === 0;
    let image = '';
    if (hasImage) {
      manifest.push(`<item id="i${i}" href="images/img${i}.jpg" media-type="image/jpeg"/>`);
      imageFiles.push([`OEBPS/images/img${i}.jpg`, fakeJpeg(pool, rand, imageBytes)]);
      image = `<div><img src="../images/img${i}.jpg" alt=""/></div>`;
    }
    manifest.push(`<item id="c${i}" href="text/c${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i}"/>`);
    navItems.push(`<li><a href="text/c${i}.xhtml">${title}</a></li>`);
    file(
      `OEBPS/text/c${i}.xhtml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><link rel="stylesheet" type="text/css" href="../style.css"/></head><body><h2>${title}</h2>\n${chapterBody(rand, vocabulary, wordsPerChapter)}\n${image}</body></html>`,
    );
  }
  // Calibre-style layout: all text first, then the images.
  for (const [path, data] of imageFiles) file(path, data, 'STORE');

  file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${navItems.join('')}</ol></nav></body></html>`,
  );
  file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:vach-bench:${name}</dc:identifier><dc:title>Bench ${name}</dc:title><dc:language>en</dc:language></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`,
  );

  return zip.generateAsync({ type: 'uint8array', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

const KB = 1024;
const MB = 1024 * 1024;

const FIXTURES = [
  // A: a typical long webnovel, text only.
  { key: 'a', file: 'epub-a.epub', seed: 1001, chapters: 1500, wordsPerChapter: 1100 },
  // B: the largest realistic case - 300 chapters with a ~95 KB image each (~30 MB).
  { key: 'b', file: 'epub-b.epub', seed: 2002, chapters: 300, wordsPerChapter: 1100, imageBytes: 95 * KB },
  // C: a small, normal book, for the small-book regression check.
  { key: 'c', file: 'epub-c.epub', seed: 3003, chapters: 50, wordsPerChapter: 900, coverBytes: 40 * KB },
];
const BIG_FIXTURES = [
  { key: 'd100', file: 'epub-d100.epub', seed: 4004, chapters: 600, wordsPerChapter: 1100, imageBytes: 165 * KB },
  { key: 'd300', file: 'epub-d300.epub', seed: 5005, chapters: 1500, wordsPerChapter: 1100, imageBytes: 195 * KB },
];

mkdirSync(outDir, { recursive: true });
const manifest = {};
for (const spec of [...FIXTURES, ...(withBig ? BIG_FIXTURES : [])]) {
  const started = Date.now();
  const bytes = await buildEpub({ name: spec.key, ...spec });
  const path = join(outDir, spec.file);
  writeFileSync(path, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  manifest[spec.key] = { path, bytes: bytes.length, chapters: spec.chapters, sha256 };
  console.log(`${spec.file.padEnd(16)} ${(bytes.length / MB).toFixed(2).padStart(8)} MiB  ${String(spec.chapters).padStart(5)} chapters  sha256 ${sha256.slice(0, 12)}  (${Date.now() - started} ms)`);
}
writeFileSync(join(outDir, 'fixtures.json'), JSON.stringify(manifest, null, 2));
console.log(`\nWrote fixtures.json to ${outDir}`);
