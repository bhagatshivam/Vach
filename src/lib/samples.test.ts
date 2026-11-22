import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { archiveFromJSZip, openEpub } from './epub';

// The two sample books committed in samples/ are what the owner opens on a
// phone to check Phase 4. These keep them honest: they open through the real
// reader pipeline, stay small, and contain what they promise to.

async function open(name: string) {
  const bytes = readFileSync(resolve(__dirname, '../../samples', name));
  const book = await openEpub(archiveFromJSZip(await JSZip.loadAsync(bytes)), name);
  const chapters: string[] = [];
  for (let i = 0; i < book.chapterCount; i++) chapters.push(await book.loadChapter(i));
  return { book, chapters, size: bytes.length };
}

describe('samples/tables-sample.epub', () => {
  it('is under 100 KB and opens with its five chapters', async () => {
    const { book, size } = await open('tables-sample.epub');
    expect(size).toBeLessThan(100 * 1024);
    expect(book.title).toBe('Vach table sample');
    expect(book.chapterCount).toBe(5);
  });

  it('has every table shape: narrow, 5-col, 9-col headed, headerless, colspan/rowspan, nested, stat sheet, row headers', async () => {
    const { chapters } = await open('tables-sample.epub');
    const html = chapters.join('\n');
    const tables = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('table');
    expect(tables.length).toBe(12);
    expect(html).toContain('colspan="2"');
    expect(html).toContain('rowspan="2"');
    expect(html).toMatch(/<td>Equipped<\/td>[\s\S]*<table>/); // a nested table
    expect(html).toContain('<th>Strength</th>'); // the 9-column header
    expect(html).toContain('<th>Title</th>'); // the stat sheet header row
    expect(html).toContain('<th>Intellect</th>'); // <th> row headers inside a body
  });

  it('the publisher-styled table arrives already stripped of widths, backgrounds and nowrap', async () => {
    const { chapters } = await open('tables-sample.epub');
    const styled = chapters[3].slice(chapters[3].indexOf('<table'), chapters[3].lastIndexOf('</table>') + 8);
    expect(styled).toContain('Northern Reach');
    expect(styled).toContain('<colgroup>'); // the structure stays; only its widths go
    expect(styled).not.toMatch(/width|height|bgcolor|nowrap|border=|cellpadding|background|white-space|font-size|color/);
    expect(styled).toContain('text-align: right'); // the one harmless style survives
  });

  it('carries the long unbroken URL, the long code line and the long identifier', async () => {
    const { chapters } = await open('tables-sample.epub');
    expect(chapters[4]).toMatch(/https:\/\/example\.com\/a\/very\/long\/path\/that\/never\/breaks\/(segment-of-an-unbroken-url-){8}end\?query=x{40}/);
    expect(chapters[4]).toContain('computeTheThingThatTakesAVeryLongNameAndManyArguments(firstArgument');
    expect(chapters[4]).toContain('SomeVeryLongClassNameThatKeepsGoingAndGoing');
    expect(chapters[4]).toMatch(/<pre><code>/);
  });
});

describe('samples/devanagari-sample.epub', () => {
  it('is under 100 KB, titled "वाच", with five chapters', async () => {
    const { book, size } = await open('devanagari-sample.epub');
    expect(size).toBeLessThan(100 * 1024);
    expect(book.title).toBe('वाच');
    expect(book.chapterCount).toBe(5);
  });

  it('has Marathi, Hindi and Sanskrit text, with the letters and conjuncts that stress a font', async () => {
    const { chapters } = await open('devanagari-sample.epub');
    const [title, marathi, hindi, sanskrit] = chapters;
    expect(title).toContain('वाच');
    expect(marathi).toContain('महाराष्ट्र');
    expect(marathi).toContain('ळ'); // Marathi-specific
    expect(hindi).toContain('देवनागरी');
    expect(hindi).toContain('ऑ'); // candra-o
    expect(hindi).toContain('क़'); // nukta forms
    expect(sanskrit).toContain('सत्यमेव जयते');
    expect(sanskrit).toContain('॑'); // a Vedic accent mark
  });

  it('has math, arrow and currency symbols', async () => {
    const { chapters } = await open('devanagari-sample.epub');
    const symbols = chapters[4];
    for (const symbol of ['∑', '∫', '√', '≠', '→', '⇒', '₹', '€', '£', '₿']) expect(symbols).toContain(symbol);
  });
});
