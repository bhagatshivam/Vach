import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { archiveFromJSZip, openEpub } from './epub';
import { flattenToLeafBlocks } from './readerAnchor';
import { ANCHOR_ATTR } from './toc';

// A book's own ids are never let through (they could clobber the page's names); each is kept as the inert
// data-vach-anchor attribute so a table-of-contents entry can find its place. Only attributes change: the
// block structure that saved reading positions are counted in must be exactly what it was.

async function chapterHtml(body: string): Promise<string> {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="o.opf" media-type="x"/></rootfiles></container>');
  zip.file('o.opf', '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>');
  zip.file('a.xhtml', `<html><body>${body}</body></html>`);
  const book = await openEpub(archiveFromJSZip(await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }))), 'x');
  return book.loadChapter(0);
}

const root = (html: string) => {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
};
const anchors = (html: string) => Array.from(root(html).querySelectorAll(`[${ANCHOR_ATTR}]`)).map((el) => [el.tagName.toLowerCase(), el.getAttribute(ANCHOR_ATTR)]);

describe('chapter anchors', () => {
  it('keeps an id as data-vach-anchor and never as an id', async () => {
    const html = await chapterHtml('<h2 id="part2">Part</h2><p id="p1">text</p>');
    expect(anchors(html)).toEqual([['h2', 'part2'], ['p', 'p1']]);
    expect(root(html).querySelector('[id]')).toBeNull();
  });

  it('an empty <a id> inside a heading hands its anchor to the heading', async () => {
    const html = await chapterHtml('<h2><a id="link2HCH0001"></a>CHAPTER I</h2><p>x</p>');
    expect(anchors(html)).toEqual([['h2', 'link2HCH0001']]);
  });

  it('an <a name> anchor works too; one at the top level goes to the next element', async () => {
    const html = await chapterHtml('<a name="top"></a><p>first</p><div><a name="deep"></a><p>second</p></div>');
    expect(anchors(html)).toEqual([['p', 'top'], ['div', 'deep']]);
  });

  it('the first anchor on an element wins; later ones on the same element are dropped, not stacked', async () => {
    const html = await chapterHtml('<h2 id="one"><a id="two"></a>T</h2>');
    expect(anchors(html)).toEqual([['h2', 'one']]);
  });

  it('names that would clobber the page are plain data, not ids or names', async () => {
    const html = await chapterHtml('<p id="location">a</p><p id="document">b</p><img id="cookie" alt="x"><form id="x"></form>');
    const el = root(html);
    expect(el.querySelector('[id]')).toBeNull();
    expect(el.querySelector('[name]')).toBeNull();
    expect(anchors(html).map((a) => a[1])).toContain('location');
  });

  it('absurdly long ids are not kept', async () => {
    const html = await chapterHtml(`<p id="${'x'.repeat(500)}">a</p>`);
    expect(anchors(html)).toEqual([]);
  });

  it('values cannot carry markup out of the attribute', async () => {
    const html = await chapterHtml('<p id=\'a"><img src=x onerror=alert(1)>\'>t</p>');
    // The text survives only inside the quoted value (escaped); no element or event attribute comes out of it.
    const el = root(html);
    expect(el.querySelectorAll('img')).toHaveLength(0);
    expect(Array.from(el.querySelectorAll('*')).some((node) => node.hasAttribute('onerror'))).toBe(false);
    expect(el.querySelector('p')?.getAttribute(ANCHOR_ATTR)).toBe('a"><img src=x onerror=alert(1)>');
  });

  it('changes attributes only: the chapter has exactly the same block structure with or without ids', async () => {
    const withIds = await chapterHtml('<h2 id="a"><a id="b"></a>T</h2><p id="c">one</p><a name="d"></a><ul><li id="e">x</li></ul><div id="f"><p>in</p></div><table id="g"><tr><td id="h">c</td></tr></table>');
    const without = await chapterHtml('<h2><a></a>T</h2><p>one</p><a></a><ul><li>x</li></ul><div><p>in</p></div><table><tr><td>c</td></tr></table>');
    const stripped = withIds.replace(/ data-vach-anchor="[^"]*"/g, '');
    expect(stripped).toBe(without);
    expect(flattenToLeafBlocks(root(withIds)).length).toBe(flattenToLeafBlocks(root(without)).length);
  });
});
