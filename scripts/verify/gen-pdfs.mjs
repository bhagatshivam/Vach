#!/usr/bin/env node
// Generates the synthetic PDFs the Phase 1b measurements and checks use (never committed; written under
// node_modules/.cache/vach-bench/pdf). Deterministic.
//
//   node scripts/verify/gen-pdfs.mjs [outDir]
//
//   text-1000.pdf   1,000 dense text pages (about 2,400 characters each) with a 20-entry outline
//   text-3000.pdf   3,000 of them
//   text-4500.pdf   4,500 of them (past the 2^23 px blank limit when every page is mounted)
//   scans-100mb.pdf 300 pages that are each one full-page picture of incompressible noise: about 100 MB (classic cross-reference
//                   table: pdf.js reads a file like this whole when it opens it, wherever its objects are)
//   scans-modern.pdf the same pages with the cross-reference in object streams (what most producers write today): pdf.js
//                   reads the first MiB and the end of the file to open it
//
// Every text page starts with MARK_<page index> so a check can tell which page is on screen.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { png, rng } from '../samples/docxBuilder.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(repo, 'package.json'));
const { PDFDocument, StandardFonts, PDFName, PDFHexString } = require('pdf-lib');

const outDir = resolve(process.argv[2] ?? join(repo, 'node_modules/.cache/vach-bench/pdf'));
mkdirSync(outDir, { recursive: true });

const WORDS = 'the caravan reached the ridge at dusk and from there the whole valley lay open beneath them the river the long road the lamps of the town coming on one by one while somewhere a bell was ringing for the evening and nobody spoke of what the morning would bring'.split(' ');

function paragraph(random, chars) {
  const words = [];
  let length = 0;
  while (length < chars) {
    const word = WORDS[Math.floor(random() * WORDS.length)];
    words.push(word);
    length += word.length + 1;
  }
  const text = words.join(' ');
  return text[0].toUpperCase() + text.slice(1) + '.';
}

/** An outline of `count` entries, evenly spread over the pages. */
function addOutline(pdf, pages, count) {
  const ctx = pdf.context;
  const outlineRef = ctx.nextRef();
  const step = Math.max(1, Math.floor(pages.length / count));
  const refs = [];
  const entries = [];
  for (let i = 0; i < count; i++) refs.push(ctx.nextRef());
  for (let i = 0; i < count; i++) {
    const pageIndex = Math.min(pages.length - 1, i * step);
    const dict = {
      Title: PDFHexString.fromText(`Part ${i + 1} (page ${pageIndex + 1})`),
      Parent: outlineRef,
      Dest: ctx.obj([pages[pageIndex].ref, PDFName.of('XYZ'), null, null, null]),
    };
    if (i > 0) dict.Prev = refs[i - 1];
    if (i < count - 1) dict.Next = refs[i + 1];
    ctx.assign(refs[i], ctx.obj(dict));
    entries.push(pageIndex);
  }
  ctx.assign(outlineRef, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[count - 1], Count: count }));
  pdf.catalog.set(PDFName.of('Outlines'), outlineRef);
}

async function textPdf(pageCount, outlineCount) {
  const random = rng(31337);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    const page = pdf.addPage([420, 595]);
    pages.push(page);
    let y = 555;
    page.drawText(`MARK_${p}`, { x: 40, y, size: 9, font });
    y -= 22;
    for (let k = 0; k < 4; k++) {
      const text = paragraph(random, 560);
      page.drawText(text, { x: 40, y, size: 10, font, maxWidth: 340, lineHeight: 13 });
      y -= 13 * Math.ceil((text.length * 5) / 340) + 14;
    }
  }
  if (outlineCount > 0) addOutline(pdf, pages, outlineCount);
  return pdf.save({ useObjectStreams: false });
}

async function scansPdf(pageCount, imageBytes, objectStreams) {
  const random = rng(4242);
  const pdf = await PDFDocument.create();
  const side = Math.round(Math.sqrt(imageBytes / 3));
  for (let p = 0; p < pageCount; p++) {
    const noise = png(side, side, () => [Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256)], 0);
    const image = await pdf.embedPng(noise);
    const page = pdf.addPage([420, 595]);
    page.drawImage(image, { x: 0, y: 0, width: 420, height: 595 });
  }
  return pdf.save({ useObjectStreams: objectStreams });
}

const jobs = [
  ['text-1000.pdf', () => textPdf(1000, 20)],
  ['text-3000.pdf', () => textPdf(3000, 30)],
  ['text-4500.pdf', () => textPdf(4500, 30)],
  ['scans-100mb.pdf', () => scansPdf(300, 340_000, false)],
  ['scans-modern.pdf', () => scansPdf(300, 340_000, true)],
];
const only = process.argv.slice(3);
for (const [name, make] of jobs) {
  if (only.length > 0 && !only.includes(name)) continue;
  const started = Date.now();
  const bytes = await make();
  writeFileSync(join(outDir, name), bytes);
  console.log(`${name.padEnd(18)} ${(bytes.length / 1048576).toFixed(1)} MB  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}
