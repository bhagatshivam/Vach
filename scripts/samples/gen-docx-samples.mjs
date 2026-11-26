#!/usr/bin/env node
// Generates the two Word samples in samples/ for checking Phase 2 (.docx support) on a phone and in headless Chromium:
//   docx-sample.docx       headings 1-3, bold-only fake headings, bulleted and numbered lists, a simple table, a
//                          9-column table, a table with merged cells, a PNG, a footnote, an endnote, internal links
//   docx-no-headings.docx  about 20,000 words with no heading styles at all (split into "Section N" by Vach)
// Deterministic: the same script gives the same bytes.
//
//   node scripts/samples/gen-docx-samples.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bookmark, buildDocx, endnoteRef, footnoteRef, heading, li, link, p, paragraphText, picture, png, rng, run, table } from './docxBuilder.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(repo, 'samples');
mkdirSync(outDir, { recursive: true });

// ---- docx-sample.docx ---------------------------------------------------------------------------------------------------

const random = rng(20260401);
const para = (words = 70) => p(paragraphText(random, words));

// A 600 x 400 picture: flat colour bands and a frame, so it is tiny on disk.
const picturePng = png(600, 400, (x, y) => {
  if (x < 8 || y < 8 || x >= 592 || y >= 392) return [30, 34, 48];
  return Math.floor(y / 80) % 2 === 0 ? [52, 110, 176] : [226, 178, 58];
});

const body = [
  // Front matter before the first heading.
  p(run('A sample document for Vach', { bold: true })),
  para(40),
  heading(1, 'Part One: Headings and text'),
  para(),
  p(
    run('Here is a sentence with a footnote') +
      footnoteRef(2) +
      run(' and, further on, an endnote') +
      endnoteRef(3) +
      run('. Tap either number to land on its note; the note links back. See also the ') +
      link('table_section', 'tables section') +
      run('.'),
  ),
  heading(2, 'Chapter One: Lists'),
  para(),
  p(run('Bold only, a fake heading', { bold: true })),
  li('First bullet'),
  li('Second bullet'),
  li('A nested bullet', 1, 1),
  li('Third bullet'),
  p(run('Another bold-only line that is not a heading', { bold: true })),
  li('Step one', 2),
  li('Step two', 2),
  li('Sub-step a', 2, 1),
  li('Step three', 2),
  heading(3, 'A third-level heading'),
  para(),
  heading(2, 'Chapter Two: Tables'),
  bookmark(10, 'table_section', p(run('A simple two-column table:'))),
  table([['Item', 'Price'], ['Healing potion', '50 gold'], ['Iron sword', '120 gold'], ['Traveller’s cloak', '75 gold']], { header: true }),
  p(run('A nine-column table (too wide for a phone, so it adapts):')),
  table(
    [
      ['Name', 'Lvl', 'HP', 'MP', 'STR', 'DEX', 'INT', 'LUK', 'Notes'],
      ['Aria', '12', '340', '120', '14', '22', '30', '9', 'Fast caster'],
      ['Bram', '14', '520', '40', '31', '12', '8', '11', 'Front line'],
      ['Cai', '11', '280', '200', '9', '18', '35', '15', 'Support'],
    ],
    { header: true },
  ),
  p(run('A table with merged cells:')),
  table([
    [{ text: 'Region', vMerge: 'restart' }, { text: 'Sales', span: 2 }],
    [{ text: '', vMerge: 'continue' }, 'Q1', 'Q2'],
    [{ text: 'North', vMerge: 'restart' }, '10', '12'],
    [{ text: '', vMerge: 'continue' }, '11', '13'],
  ]),
  heading(1, 'Part Two: Pictures and back matter'),
  para(),
  heading(2, 'Chapter Three: A picture'),
  p(run('A 600 x 400 picture (tap it to zoom):')),
  picture('rIdImg1', 5486400, 3657600, 'Blue and gold bands in a dark frame'),
  para(),
  heading(2, 'Chapter Four: The end'),
  para(60),
  p(run('Back to the ') + link('top_heading', 'first heading') + run('.')),
].join('');
// Give the first heading a bookmark for the link above.
const withBookmark = body.replace(heading(1, 'Part One: Headings and text'), bookmark(11, 'top_heading', heading(1, 'Part One: Headings and text')));

const sample = await buildDocx(withBookmark, {
  title: 'Vach DOCX Sample',
  images: [{ name: 'image1.png', bytes: picturePng }],
  footnotes: [[2, 'This is the footnote text. It sits at the foot of the page in Word; here it is collected at the end.']],
  endnotes: [[3, 'This is the endnote text.']],
});
writeFileSync(join(outDir, 'docx-sample.docx'), sample);
console.log(`samples/docx-sample.docx  ${sample.length.toLocaleString()} bytes`);

// ---- docx-no-headings.docx --------------------------------------------------------------------------------------------------

const random2 = rng(7777);
const paragraphs = [];
let words = 0;
while (words < 20000) {
  const n = 60 + Math.floor(random2() * 140);
  paragraphs.push(p(paragraphText(random2, n)));
  words += n;
}
// A bold-only line now and then, and one list, so it is not just a wall of identical paragraphs.
paragraphs.splice(40, 0, p(run('A bold line that is not a heading', { bold: true })));
paragraphs.splice(41, 0, li('A bullet'), li('Another bullet'));
const noHeadings = await buildDocx(paragraphs.join(''), { title: 'Vach DOCX with no headings' });
writeFileSync(join(outDir, 'docx-no-headings.docx'), noHeadings);
console.log(`samples/docx-no-headings.docx  ${noHeadings.length.toLocaleString()} bytes  (~${words.toLocaleString()} words)`);
