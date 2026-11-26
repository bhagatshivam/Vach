import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { convertDocx } from './docxConvert';
import { TARGET_WORDS_PER_SECTION, linkifyInternalLinks, openDocx, sliceDocxHtml } from './docx';
import { flattenToLeafBlocks } from './readerAnchor';
import { flattenToc } from './toc';
import type { DocxConversion } from './docxTypes';

afterEach(() => vi.restoreAllMocks());

const words = (n: number, label = 'w') => Array.from({ length: n }, (_, i) => `${label}${i}`).join(' ');
const para = (n: number, label?: string) => `<p>${words(n, label)}</p>`;
const text = (html: string) => (html.replace(/<[^>]*>/g, ' ').match(/\S+/g) ?? []).length;
const summary = (items: ReturnType<typeof flattenToc>) => items.map((i) => `${'-'.repeat(i.depth)}${i.title}>${i.chapterIndex}${i.fragment ? '#' + i.fragment : ''}`);
const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const fake = (html: string, extra: Partial<DocxConversion> = {}) => async (): Promise<DocxConversion> => ({ html, images: [], title: null, warnings: [], ...extra });

describe('sliceDocxHtml - with headings', () => {
  const html = `<p>front matter</p><h1>Part One</h1>${para(20)}<h2>Chapter A</h2>${para(20)}<h3>Detail</h3>${para(5)}<h2>Chapter B</h2>${para(20)}<h1>Part Two</h1>${para(20)}`;

  it('starts a chapter at every h1 and h2, and not at h3; text before the first heading is its own chapter', () => {
    const { chapters, hasHeadings } = sliceDocxHtml(html, 'My Doc');
    expect(hasHeadings).toBe(true);
    expect(chapters.map((c) => c.title)).toEqual(['My Doc', 'Part One', 'Chapter A', 'Chapter B', 'Part Two']);
    expect(chapters[0].html).toBe('<p>front matter</p>');
    expect(chapters[1].html.startsWith('<h1>Part One</h1>')).toBe(true);
    // The h3 and its text stay inside Chapter A.
    expect(chapters[2].html).toContain('<h3');
    expect(chapters[2].html).toContain('Detail');
    // Nothing is lost or duplicated: every word of the input is in exactly one chapter.
    expect(chapters.reduce((n, c) => n + text(c.html), 0)).toBe(text(html));
  });

  it('builds the TOC from h1-h3, nested by level, with an anchor for the third-level heading', () => {
    const { toc } = sliceDocxHtml(html, 'My Doc');
    expect(summary(flattenToc(toc))).toEqual(['My Doc>0', 'Part One>1', '-Chapter A>2', '--Detail>2#vach-heading-0', '-Chapter B>3', 'Part Two>4']);
    expect(new Set(flattenToc(toc).map((i) => i.id)).size).toBe(6);
  });

  it('gives the third-level heading its id in the chapter, so the jump can find it', () => {
    const { chapters, anchors } = sliceDocxHtml(html, 'My Doc');
    expect(chapters[2].html).toContain('<h3 id="vach-heading-0">Detail</h3>');
    expect(anchors.get('vach-heading-0')).toBe(2);
  });

  it('a document that starts with a heading has no front-matter chapter', () => {
    const { chapters, toc } = sliceDocxHtml(`<h1>First</h1>${para(10)}<h1>Second</h1>${para(10)}`, 'T');
    expect(chapters.map((c) => c.title)).toEqual(['First', 'Second']);
    expect(summary(flattenToc(toc))).toEqual(['First>0', 'Second>1']);
  });

  it('works when only h2 (or only h1) headings are used, and when levels are skipped', () => {
    expect(summary(flattenToc(sliceDocxHtml(`<h2>A</h2>${para(3)}<h2>B</h2>${para(3)}`, 'T').toc))).toEqual(['A>0', 'B>1']);
    expect(summary(flattenToc(sliceDocxHtml(`<h1>A</h1>${para(3)}<h3>deep</h3>${para(3)}`, 'T').toc))).toEqual(['A>0', '-deep>0#vach-heading-0']);
  });

  it('an empty heading gets a "Section N" title in the TOC', () => {
    const { toc, chapters } = sliceDocxHtml(`<h1>  </h1>${para(5)}<h1>Real</h1>${para(5)}`, 'T');
    expect(summary(flattenToc(toc))).toEqual(['Section 1>0', 'Real>1']);
    expect(chapters).toHaveLength(2);
  });

  it('headings with markup and extra whitespace give a clean title', () => {
    const { toc } = sliceDocxHtml(`<h1>The  <em>Long</em>\n Road</h1>${para(5)}`, 'T');
    expect(toc[0].title).toBe('The Long Road');
  });

  it('a front matter of only bookmarks is not a chapter', () => {
    const { chapters } = sliceDocxHtml(`<a id="x"></a><h1>One</h1>${para(4)}`, 'T');
    expect(chapters).toHaveLength(1);
    expect(chapters[0].html.startsWith('<a id="x"></a><h1>One</h1>')).toBe(true);
  });

  it('a chapter is never split in the middle of a block: block counts add up', () => {
    const { chapters } = sliceDocxHtml(`<h1>A</h1>${para(5)}<ul><li>x</li><li>y</li></ul><table><tr><td>c</td></tr></table><h1>B</h1>${para(5)}`, 'T');
    const parse = (h: string) => {
      const d = document.createElement('div');
      d.innerHTML = h;
      return flattenToLeafBlocks(d).length;
    };
    // The heading, the paragraph, the two list items and the table cell; then the heading and its paragraph.
    expect(chapters.map((c) => parse(c.html))).toEqual([5, 2]);
  });
});

describe('sliceDocxHtml - no headings', () => {
  const doc = (paragraphs: number, wordsEach: number) => Array.from({ length: paragraphs }, (_, i) => para(wordsEach, `p${i}_`)).join('');

  it('cuts at paragraph boundaries about every 2,750 words, titled "Section N"', () => {
    const { chapters, toc, hasHeadings } = sliceDocxHtml(doc(120, 100), 'T'); // 12,000 words
    expect(hasHeadings).toBe(false);
    expect(toc).toEqual([]);
    expect(chapters.map((c) => c.title)).toEqual(chapters.map((_, i) => `Section ${i + 1}`));
    // Every section but the last is between 2,750 and 2,850 words: it stops at the first paragraph break past the target.
    for (const chapter of chapters.slice(0, -1)) {
      expect(chapter.words).toBeGreaterThanOrEqual(TARGET_WORDS_PER_SECTION);
      expect(chapter.words).toBeLessThan(TARGET_WORDS_PER_SECTION + 100);
      expect(chapter.words).toBe(text(chapter.html));
    }
    expect(chapters.reduce((n, c) => n + c.words, 0)).toBe(12000);
  });

  it('never cuts inside a paragraph', () => {
    const { chapters } = sliceDocxHtml(doc(60, 333), 'T');
    for (const chapter of chapters) {
      expect(chapter.html.startsWith('<p>')).toBe(true);
      expect(chapter.html.endsWith('</p>')).toBe(true);
      expect((chapter.html.match(/<p>/g) ?? []).length).toBe((chapter.html.match(/<\/p>/g) ?? []).length);
    }
  });

  it('keeps one huge paragraph whole, and a short document as a single section', () => {
    expect(sliceDocxHtml(para(9000), 'T').chapters).toHaveLength(1);
    const short = sliceDocxHtml(doc(5, 100), 'T');
    expect(short.chapters.map((c) => c.title)).toEqual(['Section 1']);
  });

  it('folds a tiny last section into the one before it', () => {
    const { chapters } = sliceDocxHtml(doc(28, 100) + para(60, 'tail'), 'T'); // 2,800 words then 60
    expect(chapters).toHaveLength(1);
    expect(chapters[0].html).toContain('tail59');
    // ...but a last section of real size stays its own.
    expect(sliceDocxHtml(doc(28, 100) + para(1500, 'tail'), 'T').chapters).toHaveLength(2);
  });

  it('a 100,000-word document is about 36 sections', () => {
    const { chapters } = sliceDocxHtml(doc(1000, 100), 'T');
    expect(chapters.length).toBeGreaterThanOrEqual(35);
    expect(chapters.length).toBeLessThanOrEqual(37);
  });

  it('tables and lists count as one block each and are not split', () => {
    const table = `<table>${'<tr><td>a b c d e f g h i j</td></tr>'.repeat(400)}</table>`; // 4,000 words in one block
    const { chapters } = sliceDocxHtml(para(100) + table + para(100), 'T');
    expect(chapters.some((c) => (c.html.match(/<table>/g) ?? []).length === 1 && (c.html.match(/<\/table>/g) ?? []).length === 1)).toBe(true);
  });
});

describe('sliceDocxHtml - empty documents', () => {
  it('shows a message instead of nothing', () => {
    for (const html of ['', '   ', '<p></p>', '<p>  </p><p></p>']) {
      const { chapters, toc } = sliceDocxHtml(html, 'Empty');
      expect(chapters).toHaveLength(1);
      expect(chapters[0].html).toContain('This document is empty.');
      expect(toc).toEqual([]);
    }
  });

  it('a document that is only a picture is not empty', () => {
    const { chapters } = sliceDocxHtml('<p><img src="vach-docx-image:1"></p>', 'T');
    expect(chapters[0].html).toContain('<img');
    expect(chapters[0].html).not.toContain('is empty');
  });
});

describe('anchors across chapters', () => {
  const html = `<h1>One</h1><p>see<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup></p>${para(5)}<h1>Two</h1>${para(5)}<ol><li id="footnote-1"><p>the note <a href="#footnote-ref-1">back</a></p></li></ol>`;

  it('records which chapter every id lives in', () => {
    const { anchors } = sliceDocxHtml(html, 'T');
    expect(anchors.get('footnote-ref-1')).toBe(0);
    expect(anchors.get('footnote-1')).toBe(1);
    expect(anchors.has('nope')).toBe(false);
  });

  it('a bookmark just before a heading goes with the heading, not the chapter before it', () => {
    const { chapters, anchors } = sliceDocxHtml(`<h1>One</h1>${para(5)}<a id="bm"></a><h1>Two</h1>${para(5)}`, 'T');
    expect(chapters[0].html).not.toContain('id="bm"');
    expect(chapters[1].html.startsWith('<a id="bm"></a><h1>Two</h1>')).toBe(true);
    expect(anchors.get('bm')).toBe(1);
  });

  it('a bookmark at a section boundary of a heading-less document stays with the paragraph it marks', () => {
    // 100-word paragraphs: the first section ends after paragraph 27 (2,800 words), so the bookmark before 28 opens the next.
    const body = Array.from({ length: 60 }, (_, i) => para(100, `x${i}_`)).join('').replace('<p>x28_0', '<a id="edge"></a><p>x28_0');
    const { anchors, chapters } = sliceDocxHtml(body, 'T');
    expect(chapters.length).toBeGreaterThanOrEqual(2);
    expect(chapters[1].html.startsWith('<a id="edge"></a><p>x28_0')).toBe(true);
    expect(chapters[0].html).not.toContain('id="edge"');
    expect(anchors.get('edge')).toBe(1);
  });

  it('a name on an <a> counts like an id; the first of a duplicated id wins', () => {
    const { anchors } = sliceDocxHtml(`<h1>A</h1><a name="n1"></a>${para(3)}<h1>B</h1><p id="dup">x</p>${para(2)}<h1>C</h1><p id="dup">y</p>`, 'T');
    expect(anchors.get('n1')).toBe(0);
    expect(anchors.get('dup')).toBe(1);
  });
});

describe('linkifyInternalLinks', () => {
  const run = (html: string, ids: string[]) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    linkifyInternalLinks(doc, new Map(ids.map((id) => [id, 0])));
    return doc.body.innerHTML;
  };

  it('turns a link to a known id into a tappable span that keeps its own id as a target', () => {
    const out = run('<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup>', ['footnote-1', 'footnote-ref-1']);
    expect(out).toBe('<sup><span data-vach-link="footnote-1" id="footnote-ref-1">[1]</span></sup>');
  });

  it('leaves links to nowhere, external links and non-link anchors alone (the sanitizer unwraps them)', () => {
    const out = run('<a href="#missing">a</a><a href="https://example.com">b</a><a href="mailto:x@y.z">c</a><a id="just-a-target"></a>', ['other']);
    expect(out).not.toContain('data-vach-link');
  });

  it('decodes percent-escapes in the target and survives a malformed one', () => {
    expect(run('<a href="#a%20b">x</a>', ['a b'])).toContain('data-vach-link="a b"');
    expect(() => run('<a href="#%E0%A4%A">x</a>', ['q'])).not.toThrow();
  });

  it('refuses an absurdly long target', () => {
    const id = 'z'.repeat(300);
    expect(run(`<a href="#${id}">x</a>`, [id])).not.toContain('data-vach-link');
  });
});

describe('openDocx - the book', () => {
  const html = `<h1>One</h1>${para(30)}<p>see<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup></p><h1>Two</h1>${para(30)}<ol><li id="footnote-1"><p>note <a href="#footnote-ref-1">back</a></p></li></ol>`;

  it('is a book the reader opens like an EPUB: title, chapters, stream, TOC, weights', async () => {
    const book = await openDocx(new ArrayBuffer(8), 'file name', { convert: fake(html, { title: 'From core.xml' }) });
    expect(book.title).toBe('From core.xml');
    expect(book.chapterCount).toBe(2);
    expect(book.chapterWeights).toHaveLength(2);
    expect(book.chapterWeights!.every((w) => w > 0)).toBe(true);
    expect((await book.toc()).map((t) => t.title)).toEqual(['One', 'Two']);
    const events = [];
    for await (const e of book.stream(0)) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['title', 'total', 'chapter', 'chapter']);
    expect(events[1]).toEqual({ type: 'total', count: 2 });
  });

  it('uses the file name when the document has no title', async () => {
    const book = await openDocx(new ArrayBuffer(8), 'Meeting notes', { convert: fake(html) });
    expect(book.title).toBe('Meeting notes');
  });

  it('stream(startIndex) begins at that chapter and loads nothing before it; an out-of-range chapter is rejected', async () => {
    const book = await openDocx(new ArrayBuffer(8), 'x', { convert: fake(html) });
    const got: string[] = [];
    for await (const e of book.stream(1)) if (e.type === 'chapter') got.push(e.html);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain('Two');
    await expect(book.loadChapter(5)).rejects.toThrow(RangeError);
  });

  it('a heading-less document lists "Section N" in the Contents', async () => {
    const book = await openDocx(new ArrayBuffer(8), 'x', { convert: fake(Array.from({ length: 60 }, (_, i) => para(100, `q${i}_`)).join('')) });
    expect((await book.toc()).map((t) => t.title)).toEqual(Array.from({ length: book.chapterCount }, (_, i) => `Section ${i + 1}`));
    expect(book.chapterCount).toBeGreaterThanOrEqual(2);
  });

  it('internal links come out tappable and every target is an anchor in the chapter that holds it', async () => {
    const book = await openDocx(new ArrayBuffer(8), 'x', { convert: fake(html) });
    const first = await book.loadChapter(0);
    const last = await book.loadChapter(1);
    expect(first).toContain('data-vach-link="footnote-1"');
    expect(first).toContain('data-vach-anchor="footnote-ref-1"');
    expect(last).toContain('data-vach-link="footnote-ref-1"');
    expect(last).toContain('data-vach-anchor="footnote-1"');
    expect(first).not.toMatch(/<a[ >]/);
    expect(last).not.toMatch(/<a[ >]/);
    expect(book.resolveLink!('footnote-1')).toEqual({ chapterIndex: 1, fragment: 'footnote-1' });
    expect(book.resolveLink!('footnote-ref-1')).toEqual({ chapterIndex: 0, fragment: 'footnote-ref-1' });
    expect(book.resolveLink!('nope')).toBeNull();
  });

  it('empty documents open on a message', async () => {
    const book = await openDocx(new ArrayBuffer(8), 'x', { convert: fake('') });
    expect(book.chapterCount).toBe(1);
    expect(await book.loadChapter(0)).toContain('This document is empty.');
  });

  it('a converter error reaches the caller untouched', async () => {
    await expect(openDocx(new ArrayBuffer(8), 'x', { convert: async () => Promise.reject(new Error('boom')) })).rejects.toThrow('boom');
  });
});

describe('the real sample documents, end to end', () => {
  const open = async (file: string) => openDocx(toBuffer(readFileSync(file)), 'fallback', { convert: convertDocx });

  it('docx-sample.docx: title, nested Contents, tables, picture sized before mount, links and notes', async () => {
    const book = await open('samples/docx-sample.docx');
    expect(book.title).toBe('Vach DOCX Sample');
    expect(book.chapterCount).toBe(7);
    expect(summary(flattenToc(await book.toc()))).toEqual([
      'Vach DOCX Sample>0',
      'Part One: Headings and text>1',
      '-Chapter One: Lists>2',
      '--A third-level heading>2#vach-heading-0',
      '-Chapter Two: Tables>3',
      'Part Two: Pictures and back matter>4',
      '-Chapter Three: A picture>5',
      '-Chapter Four: The end>6',
    ]);
    const chapters = await Promise.all(Array.from({ length: book.chapterCount }, (_, i) => book.loadChapter(i)));
    const all = chapters.join('');
    expect(all).toContain('colspan="2"');
    expect(all).toContain('rowspan="2"');
    // The picture is a blob: URL of the image store, with its size and aspect-ratio stamped.
    expect(all).toMatch(/<img[^>]*src="blob:[^"]+"/);
    expect(all).toContain('width="600"');
    expect(all).toContain('height="400"');
    expect(all).toContain('aspect-ratio: 600 / 400');
    expect(all).not.toContain('vach-docx-image');
    expect(all).not.toContain('data:image');
    // Footnote and endnote: tappable numbers in one chapter, the notes (anchors) in the last.
    expect(all).toContain('data-vach-link="footnote-2"');
    expect(all).toContain('data-vach-link="endnote-3"');
    expect(chapters[6]).toContain('data-vach-anchor="footnote-2"');
    expect(chapters[6]).toContain('data-vach-anchor="endnote-3"');
    expect(book.resolveLink!('footnote-2')).toEqual({ chapterIndex: 6, fragment: 'footnote-2' });
    // A cross-reference to a bookmark in a later chapter, and one back to the first heading.
    expect(book.resolveLink!('table_section')?.chapterIndex).toBe(3);
    expect(book.resolveLink!('top_heading')?.chapterIndex).toBe(1);
    book.close();
  });

  it("the picture's original can be re-opened at full detail (the lightbox), and is freed with the book", async () => {
    const book = await open('samples/docx-sample.docx');
    const chapter = await book.loadChapter(5);
    const src = /src="(blob:[^"#]+)/.exec(chapter)![1];
    const full = await book.images.full(src);
    expect(full).not.toBeNull();
    expect(full).toMatchObject({ width: 600, height: 400 });
    full!.release();
    book.close();
    expect(book.images.liveUrlCount).toBe(0);
  });

  it('docx-no-headings.docx: about 20,000 words in 7-8 sections of 2,750-2,850 words', async () => {
    const book = await open('samples/docx-no-headings.docx');
    expect(book.title).toBe('Vach DOCX with no headings');
    expect(book.chapterCount).toBeGreaterThanOrEqual(7);
    expect(book.chapterCount).toBeLessThanOrEqual(8);
    expect((await book.toc()).map((t) => t.title)).toEqual(Array.from({ length: book.chapterCount }, (_, i) => `Section ${i + 1}`));
    const sizes = [];
    for (let i = 0; i < book.chapterCount; i++) sizes.push(text(await book.loadChapter(i)));
    expect(sizes.reduce((a, b) => a + b, 0)).toBeGreaterThan(19000);
    for (const size of sizes.slice(0, -1)) expect(size).toBeGreaterThanOrEqual(TARGET_WORDS_PER_SECTION - 50);
  });
});
