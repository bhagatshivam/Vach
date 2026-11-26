#!/usr/bin/env node
// Generates the Word documents the Phase 2 benchmarks use (not committed: they are big):
//   words-100k.docx     100,000 words in ordinary paragraphs, no heading styles (so ~36 virtual sections), with a table
//                       every 50 paragraphs, some bold/italic, and 20 footnotes
//   words-100k-headings.docx   the same text under ~40 Heading 1s
//   images-30mb.docx    about 30 MB: 24 incompressible 1.2 MB PNGs between short paragraphs and headings
//
//   node scripts/bench/gen-docx-bench.mjs [outDir]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocx, footnoteRef, heading, p, paragraphText, picture, png, rng, run, table } from '../samples/docxBuilder.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = resolve(process.argv[2] ?? join(repo, 'node_modules/.cache/vach-bench/docx'));
mkdirSync(outDir, { recursive: true });

function longText({ headings }) {
  const random = rng(424242);
  const parts = [];
  const footnotes = [];
  let words = 0;
  let index = 0;
  let nextFootnote = 2;
  while (words < 100000) {
    if (headings && words % 2500 < 100 && (parts.length === 0 || words - (parts.lastHeadingAt ?? -1e9) > 2400)) {
      parts.push(heading(1, `Chapter ${Math.floor(words / 2500) + 1}`));
      parts.lastHeadingAt = words;
    }
    const n = 60 + Math.floor(random() * 120);
    let content = run(paragraphText(random, n));
    if (index % 5 === 0) content = run(paragraphText(random, 20), { bold: true }) + run(' ') + run(paragraphText(random, n - 20), { italic: true });
    if (index % 50 === 25 && footnotes.length < 20) {
      content += footnoteRef(nextFootnote);
      footnotes.push([nextFootnote, 'A footnote in the long document. ' + paragraphText(random, 12)]);
      nextFootnote++;
    }
    parts.push(p(content));
    if (index % 50 === 49) parts.push(table([['A', 'B', 'C', 'D'], ['1', '2', '3', '4'], ['5', '6', '7', '8'], ['9', '10', '11', '12']], { header: true }));
    words += n;
    index++;
  }
  return { body: parts.join(''), footnotes, words };
}

const plain = longText({ headings: false });
const plainBytes = await buildDocx(plain.body, { title: 'Hundred thousand words', footnotes: plain.footnotes });
writeFileSync(join(outDir, 'words-100k.docx'), plainBytes);
console.log(`words-100k.docx           ${(plainBytes.length / 1e6).toFixed(2)} MB  (${plain.words.toLocaleString()} words)`);

const headed = longText({ headings: true });
const headedBytes = await buildDocx(headed.body, { title: 'Hundred thousand words, headings', footnotes: headed.footnotes });
writeFileSync(join(outDir, 'words-100k-headings.docx'), headedBytes);
console.log(`words-100k-headings.docx  ${(headedBytes.length / 1e6).toFixed(2)} MB`);

// Images: incompressible noise, so the file really is ~30 MB.
const random = rng(99);
const images = [];
const parts = [];
for (let i = 0; i < 24; i++) {
  const noise = png(660, 640, () => [Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256)], 0);
  images.push({ name: `image${i + 1}.png`, bytes: noise });
  if (i % 6 === 0) parts.push(heading(1, `Part ${i / 6 + 1}`));
  parts.push(p(paragraphText(rng(i + 1), 60)));
  parts.push(picture(`rIdImg${i + 1}`, 5486400, 5321300, `Figure ${i + 1}`));
}
const imageBytes = await buildDocx(parts.join(''), { title: 'Image heavy', images });
writeFileSync(join(outDir, 'images-30mb.docx'), imageBytes);
console.log(`images-30mb.docx          ${(imageBytes.length / 1e6).toFixed(2)} MB  (24 pictures)`);
