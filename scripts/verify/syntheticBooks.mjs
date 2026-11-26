// Synthetic books for the headless-Chromium reader checks (nothing here ships in the app). Deterministic: the same
// arguments give the same bytes.
//
//   epub(chapters)   chapters: [{ title, paragraphs?, text?, short?, table?, wideTable?, image?: 'a' | 'b' }]
//   tallEpub()       the 10.5M px book from the PR #12 harness: 150 chapters of 15 long paragraphs
//   ordinaryEpub(n)  a Les Miserables-sized book: n chapters of 8-14 ordinary paragraphs
//
// Every chapter heading carries MARK_<index>, which the reader harness (frame-entry.tsx) uses to tell chapters apart.

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { png } from '../samples/docxBuilder.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(repo, 'package.json'));
const JSZip = require('jszip');

export const LOREM = 'The caravan reached the ridge at dusk, and from there the whole valley lay open beneath them: the river, the long road, the lamps of the town coming on one by one. ';

/** Two small, different, valid PNGs (a flat colour, so they compress to almost nothing). */
function picture(kind) {
  const colour = kind === 'a' ? [200, 90, 60] : [60, 120, 200];
  return png(kind === 'a' ? 640 : 320, kind === 'a' ? 360 : 480, () => colour);
}

export async function epub(chapters, { title = 'Synthetic' } = {}) {
  const zip = new JSZip();
  const fixed = new Date(Date.UTC(2020, 0, 1));
  const add = (path, data, compression = 'DEFLATE') => zip.file(path, data, { compression, date: fixed });
  add('mimetype', 'application/epub+zip', 'STORE');
  add('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'];
  const kinds = new Set(chapters.map((c) => c.image).filter(Boolean));
  for (const kind of kinds) {
    manifest.push(`<item id="img-${kind}" href="img-${kind}.png" media-type="image/png"/>`);
    add(`OEBPS/img-${kind}.png`, picture(kind), 'STORE');
  }
  const spine = [];
  const toc = [];
  chapters.forEach((chapter, i) => {
    manifest.push(`<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i}"/>`);
    toc.push(`<li><a href="c${i}.xhtml">${chapter.title}</a></li>`);
    const image = chapter.image ? `<p><img alt="Picture ${i}" src="img-${chapter.image}.png"/></p>` : '';
    const table = chapter.table
      ? `<table><thead><tr><th>Name</th><th>Year</th><th>Place</th><th>Notes</th></tr></thead><tbody>${Array.from({ length: 6 }, (_, r) => `<tr><td>Row ${r} of chapter ${i}</td><td>${1800 + r}</td><td>Somewhere</td><td>${LOREM.slice(0, 60)}</td></tr>`).join('')}</tbody></table>`
      : '';
    const wide = chapter.wideTable
      ? `<table><thead><tr>${Array.from({ length: 9 }, (_, c) => `<th>Heading number ${c}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: 5 }, (_, r) => `<tr>${Array.from({ length: 9 }, (_, c) => `<td>Cell ${r}.${c} has some words in it</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : '';
    const body = chapter.short
      ? `<p>${chapter.short}</p>`
      : Array.from({ length: chapter.paragraphs ?? 14 }, () => `<p>${chapter.text ?? LOREM.repeat(3)}</p>`).join('');
    add(`OEBPS/c${i}.xhtml`, `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapter.title}</title></head><body><h2>${chapter.title} MARK_${i}</h2>${body}${image}${table}${wide}</body></html>`);
  });
  add('OEBPS/nav.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${toc.join('')}</ol></nav></body></html>`);
  add('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:test</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })).toString('base64');
}

// A book so tall that its last chapters sit past 2^23 (8.4 million) CSS px of scroll offset, where Chromium paints nothing.
// Few, very long paragraphs keep the DOM small while the page gets that tall.
export const TALL = { chapters: 150, paragraphsPerChapter: 15, charsPerParagraph: 6000 };

export async function tallEpub() {
  const long = LOREM.repeat(Math.ceil(TALL.charsPerParagraph / LOREM.length)).slice(0, TALL.charsPerParagraph);
  const chapters = Array.from({ length: TALL.chapters }, (_, i) => ({ title: `Chapter ${i + 1}`, paragraphs: TALL.paragraphsPerChapter, text: long }));
  return epub(chapters, { title: 'Very tall book' });
}

/** Les Miserables-sized: hundreds of short-to-middling chapters of ordinary paragraphs. */
export async function ordinaryEpub(count = 365) {
  const chapters = Array.from({ length: count }, (_, i) => ({ title: `Chapter ${i + 1}`, paragraphs: 8 + (i % 7), text: LOREM.repeat(2 + (i % 3)) }));
  return epub(chapters, { title: 'Ordinary long book' });
}
