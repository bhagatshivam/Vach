import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { streamEpub } from './epub';

// A tiny real 1x1 red PNG, used for every image-related test below.
const PNG_1X1_RED_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUAAScy0lUAAAAASUVORK5CYII=';

function pngBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(PNG_1X1_RED_BASE64, 'base64'));
}

async function buildEpubBase64(chapterBodies: string[], imageName = 'cover.png'): Promise<string> {
  const zip = new JSZip();
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );
  zip.file(`OEBPS/Images/${imageName}`, pngBytes());

  const manifestItems = [`<item id="img0" href="Images/${imageName}" media-type="image/png"/>`];
  const spineItems: string[] = [];
  chapterBodies.forEach((body, i) => {
    manifestItems.push(`<item id="c${i}" href="Text/c${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="c${i}"/>`);
    zip.file(`OEBPS/Text/c${i}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`);
  });

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test Book</dc:title></metadata>
  <manifest>${manifestItems.join('\n')}</manifest>
  <spine>${spineItems.join('\n')}</spine>
</package>`,
  );

  return zip.generateAsync({ type: 'base64' });
}

async function sanitizedChapters(chapterBodies: string[]): Promise<string[]> {
  const base64 = await buildEpubBase64(chapterBodies);
  const chapters: string[] = [];
  for await (const event of streamEpub(base64, 'test.epub')) {
    if (event.type === 'chapter') chapters.push(event.html);
  }
  return chapters;
}

async function sanitizedChapter(body: string): Promise<string> {
  return (await sanitizedChapters([body]))[0];
}

async function buildEpubBase64WithImageBytes(chapterBodies: string[], imageBytes: Uint8Array): Promise<string> {
  const zip = new JSZip();
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );
  zip.file('OEBPS/Images/cover.png', imageBytes);

  const manifestItems = ['<item id="img0" href="Images/cover.png" media-type="image/png"/>'];
  const spineItems: string[] = [];
  chapterBodies.forEach((body, i) => {
    manifestItems.push(`<item id="c${i}" href="Text/c${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="c${i}"/>`);
    zip.file(`OEBPS/Text/c${i}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`);
  });

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test Book</dc:title></metadata>
  <manifest>${manifestItems.join('\n')}</manifest>
  <spine>${spineItems.join('\n')}</spine>
</package>`,
  );

  return zip.generateAsync({ type: 'base64' });
}

// NOTE on jsdom vs. Chromium: these tests run under jsdom (via vitest's
// jsdom environment), which gives a real DOMParser/document but does NOT
// fire img onerror/onload events, does NOT make network requests, and does
// NOT navigate the page for a <meta refresh> - so a payload "surviving" or
// "not surviving" here is a claim about the *markup DOMPurify produced*,
// never a claim about whether something actually executed or made a
// request. That execution/network proof was done separately against the
// real production bundle in real headless Chromium (zero execution, zero
// navigation, zero network capture across this exact payload set) - these
// tests exist to catch a *regression* in what survives sanitization
// cheaply and on every change, not to re-establish the original finding.
// Treat the Chromium run as authoritative; treat these as a regression net.
describe('sanitizeChapterHtml - attack payloads (regression net; Chromium run is authoritative)', () => {
  const dangerousNeedles = [
    'onerror',
    'onload',
    'ontoggle',
    'javascript:',
    '<script',
    '<style',
    '<iframe',
    '<base',
    '<meta',
    '<object',
    '<embed',
    '<link',
    '<svg',
    '<form',
    '<input',
    'background-image',
  ];

  function assertClean(html: string) {
    const lower = html.toLowerCase();
    for (const needle of dangerousNeedles) {
      expect(lower).not.toContain(needle);
    }
  }

  it('strips <script> tags, including SVG-namespaced ones', async () => {
    assertClean(await sanitizedChapter('<svg><script>window.__pwn(1)</script></svg>'));
  });

  it('strips onerror/onload/ontoggle event handler attributes', async () => {
    assertClean(await sanitizedChapter('<img src="x" onerror="window.__pwn(1)">'));
    assertClean(await sanitizedChapter('<svg onload="window.__pwn(1)"><circle r="1"/></svg>'));
    assertClean(await sanitizedChapter('<details open ontoggle="window.__pwn(1)"><summary>x</summary></details>'));
  });

  it('strips event handler attributes regardless of case', async () => {
    assertClean(await sanitizedChapter('<img src="x" OnErRoR="window.__pwn(1)">'));
  });

  it('strips javascript: on SVG <a xlink:href> (the original audit finding)', async () => {
    assertClean(await sanitizedChapter('<svg><a xlink:href="javascript:window.__pwn(1)">click</a></svg>'));
  });

  it('strips <a> entirely (default-deny: not in the tag allowlist)', async () => {
    const html = await sanitizedChapter('<a href="javascript:window.__pwn(1)">click</a>');
    assertClean(html);
    expect(html).not.toContain('<a');
  });

  it('strips <iframe srcdoc> (the original audit finding - full script execution)', async () => {
    assertClean(await sanitizedChapter('<iframe srcdoc="&lt;script&gt;parent.window.__pwn(1)&lt;/script&gt;"></iframe>'));
  });

  it('strips <iframe src>, <object>, <embed>', async () => {
    assertClean(await sanitizedChapter('<iframe src="javascript:window.__pwn(1)"></iframe>'));
    assertClean(await sanitizedChapter('<object data="javascript:window.__pwn(1)"></object>'));
    assertClean(await sanitizedChapter('<embed src="javascript:window.__pwn(1)">'));
  });

  it('strips <form>/<input> (the original audit finding - form action javascript:)', async () => {
    assertClean(await sanitizedChapter('<form action="javascript:window.__pwn(1)"><input type="submit"></form>'));
  });

  it('strips <base>', async () => {
    assertClean(await sanitizedChapter('<base href="http://evil.example/"><p>text</p>'));
  });

  it('strips <meta> (the original audit finding - meta refresh navigation hijack)', async () => {
    assertClean(await sanitizedChapter('<meta http-equiv="refresh" content="0; url=http://evil.example/">'));
  });

  it('strips <style> elements (the original audit finding - network leak via CSS)', async () => {
    assertClean(await sanitizedChapter("<style>body{background:url('http://evil.example/leak')}</style><p>text</p>"));
  });

  it('strips <link rel=stylesheet> (the original audit finding - network leak)', async () => {
    assertClean(await sanitizedChapter('<link rel="stylesheet" href="http://evil.example/leak.css">'));
  });

  it('strips background-image from inline style (the original audit finding - network leak)', async () => {
    const html = await sanitizedChapter('<div style="background-image:url(\'http://evil.example/leak\')">text</div>');
    assertClean(html);
  });

  it('strips url()/expression()/var()/calc() from any inline style value, even under an allowed property name', async () => {
    const html = await sanitizedChapter('<p style="text-indent: calc(1em + url(x))">text</p>');
    expect(html).not.toContain('calc(');
    expect(html).not.toContain('url(');
  });

  it('removes unresolved <img src> (relative path, javascript:, or anything not in the manifest) rather than leaving it live', async () => {
    const html1 = await sanitizedChapter('<img src="javascript:window.__pwn(1)">');
    expect(html1).not.toContain('javascript:');
    const html2 = await sanitizedChapter('<img src="not-in-manifest.png">');
    expect(html2).not.toContain('src="not-in-manifest.png"');
  });

  it('removes unresolved SVG <image href>/<xlink:href> rather than leaving it live', async () => {
    const html = await sanitizedChapter('<svg><image href="javascript:window.__pwn(1)" width="10" height="10"/></svg>');
    assertClean(html);
  });

  it('mXSS probes: classic <style><img onerror> and <noscript> title-smuggling do not survive', async () => {
    assertClean(await sanitizedChapter('<svg><p><style><img src="x" onerror="window.__pwn(1)"></style></svg>'));
    assertClean(
      await sanitizedChapter('<noscript><p title="</noscript><img src=x onerror=window.__pwn(1)>">text</p></noscript>'),
    );
  });
});

describe('sanitizeChapterHtml - legitimate content survives (feature matrix)', () => {
  it('keeps structural and text-formatting tags', async () => {
    const html = await sanitizedChapter(
      '<h1>H1</h1><h2>H2</h2><p>Plain <em>em</em> <strong>strong</strong> <i>i</i> <b>b</b> <u>u</u> <s>s</s> ' +
        '<del>del</del> <ins>ins</ins> <sub>sub</sub> <sup>sup</sup> <small>small</small></p><br/><hr/>' +
        '<blockquote>quote</blockquote><ul><li>one</li></ul><ol><li>two</li></ol>' +
        '<table><caption>cap</caption><thead><tr><th>h</th></tr></thead><tbody><tr><td>d</td></tr></tbody></table>' +
        '<figure><figcaption>fig</figcaption></figure><pre><code>code</code></pre>' +
        '<ruby>漢<rt>かん</rt><rp>(</rp></ruby>',
    );
    for (const tag of [
      'h1',
      'h2',
      'em',
      'strong',
      'i>',
      'b>',
      'u>',
      's>',
      'del',
      'ins',
      'sub',
      'sup',
      'small',
      'br',
      'hr',
      'blockquote',
      'ul',
      'li',
      'ol',
      'table',
      'caption',
      'thead',
      'th',
      'tbody',
      'td',
      'figure',
      'figcaption',
      'pre',
      'code',
      'ruby',
      'rt',
      'rp',
    ]) {
      expect(html.toLowerCase()).toContain(`<${tag}`);
    }
  });

  it('keeps a safe inline-style allowlist with real values', async () => {
    const html = await sanitizedChapter(
      '<p style="text-align: center; text-indent: 2em; font-style: italic; font-weight: bold; text-decoration: underline; margin-top: 1em">text</p>',
    );
    expect(html).toContain('text-align: center');
    expect(html).toContain('text-indent: 2em');
    expect(html).toContain('font-style: italic');
    expect(html).toContain('font-weight: bold');
    expect(html).toContain('text-decoration: underline');
    expect(html).toContain('margin-top: 1em');
  });

  it('drops disallowed style properties (e.g. color, font-family) while keeping allowed ones on the same element', async () => {
    const html = await sanitizedChapter('<p style="color: red; text-align: center; font-family: Comic Sans">text</p>');
    expect(html).not.toContain('color');
    expect(html).not.toContain('font-family');
    expect(html).toContain('text-align: center');
  });

  it('resolves a plain <img src> to the real data: URI from the manifest', async () => {
    const html = await sanitizedChapter('<img src="../Images/cover.png" alt="cover">');
    expect(html).toMatch(/<img[^>]*src="data:image\/png;base64,/);
    expect(html).toContain('alt="cover"');
  });

  // Regression test: DOMPurify checks every allowed attribute's *value*
  // against ALLOWED_URI_REGEXP unless the attribute name is in its own
  // uri-safe exemption list - our narrow "data:image/..." regexp (correct
  // for src) was silently dropping width/height/colspan/rowspan/lang/dir
  // whenever their value didn't look like a data:image URI, i.e. always.
  // This caught that before it ever reached a real table/image.
  it('keeps width/height/colspan/rowspan/lang/dir with real values (not silently stripped by the img-src URI check)', async () => {
    const html = await sanitizedChapter(
      '<img src="../Images/cover.png" width="100" height="50">' +
        '<table><tbody><tr><td colspan="2" rowspan="3" lang="en" dir="ltr">cell</td></tr></tbody></table>',
    );
    expect(html).toContain('width="100"');
    expect(html).toContain('height="50"');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('rowspan="3"');
    expect(html).toContain('lang="en"');
    expect(html).toContain('dir="ltr"');
  });

  it('still strips a non-data: <img src> (http(s)) even with ADD_URI_SAFE_ATTR covering other attributes', async () => {
    const html = await sanitizedChapter('<img src="http://evil.example/leak.png" width="100" alt="x">');
    expect(html).not.toContain('http://evil.example');
    expect(html).toContain('width="100"');
  });

  it('converts an SVG-wrapped cover image (<svg><image xlink:href>) into a plain <img data:...>, unwrapping the <svg>', async () => {
    const html = await sanitizedChapter('<svg width="10" height="10"><image xlink:href="../Images/cover.png" width="10" height="10"/></svg>');
    expect(html).not.toContain('<svg');
    expect(html).toMatch(/<img[^>]*src="data:image\/png;base64,/);
  });

  it('keeps multiple chapters in spine order, each independently sanitized', async () => {
    const chapters = await sanitizedChapters(['<p>CHAPTER_ONE</p>', '<p>CHAPTER_TWO<script>bad()</script></p>']);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toContain('CHAPTER_ONE');
    expect(chapters[1]).toContain('CHAPTER_TWO');
    expect(chapters[1].toLowerCase()).not.toContain('<script');
  });
});

describe('sanitizeChapterHtml - wraps <table>/<pre> in .scroll-x (wide-content containment)', () => {
  it('wraps a <table> in <div class="scroll-x">', async () => {
    const html = await sanitizedChapter('<table><tbody><tr><td>cell</td></tr></tbody></table>');
    expect(html).toMatch(/<div class="scroll-x"><table>/);
  });

  it('wraps a <pre> in <div class="scroll-x">', async () => {
    const html = await sanitizedChapter('<pre>some text</pre>');
    expect(html).toMatch(/<div class="scroll-x"><pre>/);
  });

  it('wraps each top-level <table>/<pre> independently when several appear in one chapter', async () => {
    const html = await sanitizedChapter(
      '<table><tbody><tr><td>one</td></tr></tbody></table><p>between</p><pre>two</pre>',
    );
    expect(html.match(/<div class="scroll-x">/g)).toHaveLength(2);
  });

  it('wraps a nested table at both levels (outer and inner each get their own box)', async () => {
    const html = await sanitizedChapter(
      '<table><tbody><tr><td>outer<table><tbody><tr><td>inner</td></tr></tbody></table></td></tr></tbody></table>',
    );
    expect(html.match(/<div class="scroll-x">/g)).toHaveLength(2);
    expect(html).toMatch(/<div class="scroll-x"><table>.*<div class="scroll-x"><table>/s);
  });

  it('does not wrap ordinary elements (p, h2, ul) - only table/pre get a scroll-x box', async () => {
    const html = await sanitizedChapter('<h2>Title</h2><p>text</p><ul><li>item</li></ul>');
    expect(html).not.toContain('scroll-x');
  });

  it('preserves table content and attributes exactly when wrapping', async () => {
    const html = await sanitizedChapter(
      '<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td colspan="2">Kaito</td></tr></tbody></table>',
    );
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('Kaito');
  });

  it('the scroll-x wrapper introduces no attribute beyond class (no id/style/data-* added)', async () => {
    const html = await sanitizedChapter('<pre>x</pre>');
    const wrapperTag = html.match(/<div[^>]*>/)?.[0] ?? '';
    expect(wrapperTag).toBe('<div class="scroll-x">');
  });
});

describe('per-entry decompressed-size cap (pathological chapters/images)', () => {
  it(
    'shows the per-chapter error placeholder for a chapter whose decompressed size exceeds the cap, without affecting its neighbors',
    async () => {
      const hugeBody = `<p>${'A'.repeat(11 * 1024 * 1024)}</p>`; // over the 10MB chapter cap
      const chapters = await sanitizedChapters(['<p>BEFORE_MARKER</p>', hugeBody, '<p>AFTER_MARKER</p>']);
      expect(chapters).toHaveLength(3);
      expect(chapters[0]).toContain('BEFORE_MARKER');
      expect(chapters[1]).toContain('This chapter could not be loaded');
      expect(chapters[2]).toContain('AFTER_MARKER');
    },
    20000,
  );

  it(
    'drops an image whose decompressed size exceeds the cap, same as an image that never resolves - it does not fail the chapter',
    async () => {
      const hugeImage = new Uint8Array(21 * 1024 * 1024).fill(65); // over the 20MB image cap
      const base64 = await buildEpubBase64WithImageBytes(['<p>TEXT_MARKER</p><img src="../Images/cover.png" alt="x">'], hugeImage);
      const chapters: string[] = [];
      for await (const event of streamEpub(base64, 'test.epub')) {
        if (event.type === 'chapter') chapters.push(event.html);
      }
      expect(chapters).toHaveLength(1);
      expect(chapters[0]).toContain('TEXT_MARKER');
      expect(chapters[0]).not.toContain('data:image');
      expect(chapters[0].toLowerCase()).not.toContain('could not be loaded');
    },
    20000,
  );

  it('still loads a normal-sized chapter and image well within the caps', async () => {
    const html = await sanitizedChapter('<p>NORMAL_MARKER</p><img src="../Images/cover.png" alt="x">');
    expect(html).toContain('NORMAL_MARKER');
    expect(html).toMatch(/<img[^>]*src="data:image\/png;base64,/);
  });
});
