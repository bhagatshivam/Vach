import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { bookmark, buildDocx, footnoteRef, heading, li, link, p, picture, png, run, table } from '../../scripts/samples/docxBuilder.mjs';
import { DOCX_IMAGE_SCHEME, checkDocxHeader, convertDocx, titleFromCoreXml } from './docxConvert';
import { DocxError } from './docxError';

// The real converter (mammoth) on real Word files: what it makes of headings, lists, tables, pictures, notes and links,
// and the errors for everything that is not a readable Word document.

const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const sample = () => toBuffer(readFileSync('samples/docx-sample.docx'));

const picturePng = png(40, 30, () => [200, 40, 40]);

describe('convertDocx - the sample document', () => {
  it('turns Word styles into HTML: headings, lists, tables with merged cells, notes, links', async () => {
    const { html, title, warnings } = await convertDocx(sample());
    expect(title).toBe('Vach DOCX Sample');
    expect(warnings).toEqual([]);
    expect(html).toContain('<h1>Part One: Headings and text</h1>');
    expect(html).toContain('<h2>Chapter One: Lists</h2>');
    expect(html).toContain('<h3>A third-level heading</h3>');
    expect(html).toMatch(/<ul>\s*<li>First bullet/);
    expect(html).toMatch(/<ol>\s*<li>Step one/);
    expect(html).toContain('colspan="2"');
    expect(html).toContain('rowspan="2"');
    expect(html).toMatch(/<th>/); // the tblHeader row
    // Bold-only lines stay paragraphs: they are not headings.
    expect(html).toContain('<strong>Bold only, a fake heading</strong>');
    expect(html).not.toMatch(/<h\d>[^<]*Bold only/);
    // Footnote and endnote: a reference with a link to the note, and the note linking back.
    expect(html).toMatch(/<a href="#footnote-2" id="footnote-ref-2">/);
    expect(html).toMatch(/<a href="#endnote-3" id="endnote-ref-3">/);
    expect(html).toMatch(/<li id="footnote-2">/);
    expect(html).toMatch(/<a href="#footnote-ref-2">/);
    // An internal hyperlink to a bookmark, and the bookmark.
    expect(html).toContain('href="#table_section"');
    expect(html).toContain('id="table_section"');
  });

  it('hands pictures back as bytes with a placeholder in the HTML - never a base64 string', async () => {
    const { html, images } = await convertDocx(sample());
    expect(images).toHaveLength(1);
    expect(images[0].contentType).toBe('image/png');
    expect(images[0].bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(images[0].bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(html).toContain(`src="${DOCX_IMAGE_SCHEME}1"`);
    expect(html).toContain('alt="Blue and gold bands in a dark frame"');
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('base64');
    // Each picture owns its bytes, so it can be transferred between threads.
    expect(images[0].bytes.byteOffset).toBe(0);
    expect(images[0].bytes.byteLength).toBe(images[0].bytes.buffer.byteLength);
  });
});

describe('convertDocx - pictures', () => {
  it('keeps a picture used twice once', async () => {
    const body = picture('rIdImg1', 914400, 685800, 'one') + p('between') + picture('rIdImg1', 914400, 685800, 'two');
    const { images, html } = await convertDocx(toBuffer(await buildDocx(body, { images: [{ name: 'a.png', bytes: picturePng }] })));
    expect(images).toHaveLength(1);
    expect(html.match(new RegExp(`${DOCX_IMAGE_SCHEME}1`, 'g'))).toHaveLength(2);
  });

  it('two different pictures stay two', async () => {
    const other = png(40, 30, () => [10, 200, 10]);
    const body = picture('rIdImg1', 914400, 685800, 'one') + picture('rIdImg2', 914400, 685800, 'two');
    const { images } = await convertDocx(toBuffer(await buildDocx(body, { images: [{ name: 'a.png', bytes: picturePng }, { name: 'b.png', bytes: other }] })));
    expect(images.map((i) => i.id)).toEqual([1, 2]);
  });

  it('leaves out a picture type a WebView cannot draw (EMF), with a warning, and keeps the document', async () => {
    const body = p('before') + picture('rIdImg1', 914400, 685800, 'a drawing') + p('after');
    const zip = await JSZip.loadAsync(await buildDocx(body, { images: [{ name: 'a.emf', bytes: new Uint8Array([1, 0, 0, 0, 1, 2, 3, 4]) }] }));
    zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('<Default Extension="png"', '<Default Extension="emf" ContentType="image/x-emf"/><Default Extension="png"'));
    const { images, html, warnings } = await convertDocx(toBuffer(await zip.generateAsync({ type: 'uint8array' })));
    expect(images).toEqual([]);
    expect(html).toContain('before');
    expect(html).toContain('after');
    expect(warnings.some((w) => /image\/x-emf/.test(w))).toBe(true);
  });
});

describe('convertDocx - titles', () => {
  it('reads dc:title from core.xml; none when it is absent', async () => {
    expect((await convertDocx(toBuffer(await buildDocx(p('x'), { title: 'My <Report> & Notes' })))).title).toBe('My <Report> & Notes');
    expect((await convertDocx(toBuffer(await buildDocx(p('x'))))).title).toBeNull();
  });

  it('titleFromCoreXml handles attributes, entities, markup and blank titles', () => {
    expect(titleFromCoreXml('<cp:coreProperties><dc:title xml:lang="en">A &amp; B &lt;1&gt;</dc:title></cp:coreProperties>')).toBe('A & B <1>');
    expect(titleFromCoreXml('<dc:title>  spaced \n out </dc:title>')).toBe('spaced out');
    expect(titleFromCoreXml('<dc:title>   </dc:title>')).toBeNull();
    expect(titleFromCoreXml('<dc:title/>')).toBeNull();
    expect(titleFromCoreXml('<other/>')).toBeNull();
  });
});

describe('convertDocx - what is not a readable Word document', () => {
  const failure = async (bytes: Uint8Array | ArrayBuffer) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await convertDocx(bytes instanceof Uint8Array ? toBuffer(bytes) : bytes);
      return null;
    } catch (err) {
      return err;
    } finally {
      vi.restoreAllMocks();
    }
  };

  it('an empty or tiny file is damaged', async () => {
    expect(await failure(new Uint8Array(0))).toMatchObject({ code: 'corrupt' });
    expect(await failure(new Uint8Array([1, 2]))).toMatchObject({ code: 'corrupt' });
  });

  it('plain text, a PDF and an image are not Word documents', async () => {
    expect(await failure(new TextEncoder().encode('hello there, this is just text'))).toMatchObject({ code: 'not-docx', name: 'DocxError' });
    expect(await failure(new TextEncoder().encode('%PDF-1.7 ....'))).toMatchObject({ code: 'not-docx' });
    expect(await failure(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toMatchObject({ code: 'not-docx' });
  });

  it('an encrypted document (an OLE container) is reported as password-protected; so is an old .doc', async () => {
    const ole = new Uint8Array(600);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const error = (await failure(ole)) as DocxError;
    expect(error).toBeInstanceOf(DocxError);
    expect(error.code).toBe('password-protected');
    expect(error.message).toMatch(/password/i);
  });

  it('a ZIP that is not a Word document (an EPUB) is not a Word document', async () => {
    expect(await failure(readFileSync('samples/tables-sample.epub'))).toMatchObject({ code: 'not-docx' });
  });

  it('a truncated document is damaged', async () => {
    const whole = readFileSync('samples/docx-sample.docx');
    expect(await failure(whole.subarray(0, 1500))).toMatchObject({ code: 'corrupt' });
    expect(await failure(whole.subarray(0, whole.length - 30))).toMatchObject({ code: 'corrupt' });
  });

  it('a Word package whose main part is not XML cannot be read, and says so', async () => {
    const zip = await JSZip.loadAsync(await buildDocx(p('x')));
    zip.file('word/document.xml', '<w:document><w:body><w:p>');
    const error = (await failure(await zip.generateAsync({ type: 'uint8array' }))) as DocxError;
    expect(error).toBeInstanceOf(DocxError);
    expect(['unreadable', 'corrupt']).toContain(error.code);
    expect(error.message.length).toBeGreaterThan(20);
  });

  it('every error message is a complete sentence with no technical detail', async () => {
    for (const code of ['password-protected', 'not-docx', 'corrupt', 'unreadable'] as const) {
      const message = new DocxError(code).message;
      expect(message).toMatch(/^[A-Z].*[.]$/);
      expect(message).not.toMatch(/exception|undefined|null|stack/i);
    }
  });
});

describe('checkDocxHeader', () => {
  it('accepts a ZIP signature, and names the OLE and unknown signatures', () => {
    expect(() => checkDocxHeader(new Uint8Array([0x50, 0x4b, 3, 4]))).not.toThrow();
    expect(() => checkDocxHeader(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toThrow(/password/);
    expect(() => checkDocxHeader(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toThrow(/isn't a Word/);
  });
});

describe('convertDocx - structure survives', () => {
  it('headings, a list and a footnote built from scratch convert as expected', async () => {
    const body = heading(1, 'One') + p(run('See') + footnoteRef(2)) + li('a') + li('b') + p(link('bm', 'jump')) + bookmark(5, 'bm', heading(2, 'Two')) + table([['x', 'y']]);
    const { html } = await convertDocx(toBuffer(await buildDocx(body, { footnotes: [[2, 'note']] })));
    expect(html).toContain('<h1>One</h1>');
    expect(html).toContain('<h2>Two</h2>');
    expect(html).toMatch(/<ul>/);
    expect(html).toContain('href="#bm"');
    expect(html).toMatch(/<li id="footnote-2">/);
  });
});
