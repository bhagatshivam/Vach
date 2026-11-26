import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDocx } from './docx';
import { DOCX_IMAGE_SCHEME } from './docxTypes';
import type { DocxConversion } from './docxTypes';

// Whatever the converter returns is untrusted: it goes through the same default-deny sanitizer as an EPUB chapter.
// Here the "converter" is hostile or sloppy, to show what survives.

afterEach(() => vi.restoreAllMocks());

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0x2c, 0, 0, 0, 0xc8, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44]); // 300 x 200
const chapter = async (html: string, images: DocxConversion['images'] = []) => {
  const convert = async (): Promise<DocxConversion> => ({ html, images, title: null, warnings: [] });
  const book = await openDocx(new ArrayBuffer(8), 'x', { convert });
  return { book, html: await book.loadChapter(0) };
};

describe('sanitizing converted Word HTML', () => {
  it('drops scripts, frames, forms, event handlers and javascript: links', async () => {
    const { html } = await chapter(
      '<h1>T</h1><script>alert(1)</script><iframe src="https://evil"></iframe><form action="https://evil"><input name="x"></form><p onclick="alert(1)" onmouseover="x()">hi <a href="javascript:alert(1)">click</a> <a href="https://evil/x">out</a></p><object data="x"></object><embed src="x"><svg onload="alert(1)"><circle/></svg>',
    );
    expect(html).not.toMatch(/<script|<iframe|<form|<input|<object|<embed|<svg|onclick|onmouseover|onload|javascript:|<a[ >]|href=/i);
    expect(html).toContain('hi click out');
  });

  it('keeps the structure Word produces: headings, lists, tables with spans, emphasis, sub/superscript', async () => {
    const { html } = await chapter(
      '<h1>T</h1><p><strong>b</strong> <em>i</em> x<sup>2</sup> H<sub>2</sub>O</p><ul><li>a<ul><li>b</li></ul></li></ul><ol><li>1</li></ol><table><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>',
    );
    for (const piece of ['<h1>T</h1>', '<strong>b</strong>', '<em>i</em>', '<sup>2</sup>', '<sub>2</sub>', '<ul>', '<ol>', '<th colspan="2">', '<td rowspan="2">']) expect(html).toContain(piece);
  });

  it('drops pictures that are not the document\u2019s own: remote, file:, unknown placeholders; style tricks', async () => {
    const { html } = await chapter(
      `<h1>T</h1><p><img src="https://evil/track.png" alt="a"><img src="${DOCX_IMAGE_SCHEME}99" alt="c"><img src="file:///etc/passwd" alt="d"></p><p style="background:url(https://evil/x);position:fixed;width:99999px">s</p>`,
    );
    expect(html).not.toMatch(/https?:|file:|passwd|evil/);
    expect(html).not.toMatch(/position|url\(/);
    // None of them resolves to a picture of the document, so none keeps a src.
    expect(html).not.toMatch(/<img[^>]+src=/);
  });

  it('a data: picture is re-served from the image store as a blob: URL, never left as a data: URL in the page', async () => {
    const { html, book } = await chapter('<h1>T</h1><p><img src="data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMTAgMTAiPjwvc3ZnPg==" alt="b"></p>');
    expect(html).not.toMatch(/src="data:/);
    expect(html).toMatch(/<img [^>]*src="blob:/);
    book.close();
  });

  it("a document's own picture becomes a blob: URL of the image store, sized and with its aspect-ratio, in a lazy decoded <img>", async () => {
    const { html, book } = await chapter(`<h1>T</h1><p><img src="${DOCX_IMAGE_SCHEME}1" alt="chart" width="5" height="5" style="width:5px;border:9px solid red"></p>`, [{ id: 1, contentType: 'image/png', bytes: PNG }]);
    expect(html).toMatch(/<img [^>]*src="blob:[^"]+"/);
    // The document's own width/height/style are replaced by the real ones (so layout never jumps).
    expect(html).toContain('width="300"');
    expect(html).toContain('height="200"');
    expect(html).toContain('aspect-ratio: 300 / 200');
    expect(html).not.toContain('border');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('alt="chart"');
    book.close();
  });

  it('only the reader’s own blob: URLs are allowed: a blob: URL the document invents is dropped', async () => {
    const { html, book } = await chapter('<h1>T</h1><p><img src="blob:http://localhost/not-ours" alt="x"></p>');
    expect(html).not.toContain('not-ours');
    book.close();
  });

  it('ids cannot clobber the page, and cannot carry markup out', async () => {
    const { html } = await chapter('<h1 id="location">T</h1><p id="document">x</p><p id=\'q"><img src=x onerror=alert(1)>\'>y</p>');
    const dom = document.createElement('div');
    dom.innerHTML = html;
    // No element has an id or name, so nothing can shadow a property of the page; no markup came out of a value.
    expect(dom.querySelector('[id], [name]')).toBeNull();
    expect(dom.querySelector('img')).toBeNull();
    expect(Array.from(dom.querySelectorAll('*')).some((el) => el.hasAttribute('onerror'))).toBe(false);
    expect(html).toContain('data-vach-anchor="location"');
  });

  it('a forged data-vach-link only ever names an anchor: with nothing to resolve it does nothing', async () => {
    const { html, book } = await chapter('<h1>T</h1><p><span data-vach-link="javascript:alert(1)">x</span></p>');
    // The value is only ever a lookup key for the book's anchors; it is not a URL and nothing navigates to it.
    expect(html).not.toMatch(/href|onclick/);
    expect(book.resolveLink!('javascript:alert(1)')).toBeNull();
  });
});
