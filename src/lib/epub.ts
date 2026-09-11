import JSZip from 'jszip';

export interface ParsedEpub {
  title: string;
  chaptersHtml: string[];
}

const STRIPPED_INLINE_STYLE_PROPS = new Set([
  'font-family',
  'font-size',
  'line-height',
  'color',
  'background',
  'background-color',
]);

function localName(el: Element): string {
  return el.localName || el.tagName.split(':').pop() || el.tagName;
}

function findByLocalName(doc: Document, name: string): Element[] {
  return Array.from(doc.getElementsByTagName('*')).filter((el) => localName(el) === name);
}

/**
 * Resolves a zip-relative href (as found in an OPF manifest item or a
 * chapter's own <img src>) against the directory of the file that
 * referenced it. Handles "../" and "./" segments and a small amount of
 * real-world sloppiness (fragments/queries on hrefs, leading "/").
 */
function resolveRelativePath(baseDir: string, relativeHref: string): string {
  const clean = relativeHref.split('#')[0].split('?')[0];

  if (clean.startsWith('/')) {
    return clean
      .slice(1)
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent)
      .join('/');
  }

  const baseParts = baseDir ? baseDir.split('/').filter(Boolean) : [];
  const relParts = clean.split('/').filter((p) => p.length > 0 && p !== '.');

  const stack = [...baseParts];
  for (const part of relParts) {
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.map(decodeURIComponent).join('/');
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function findOpfPath(containerXml: string): string {
  const doc = new DOMParser().parseFromString(containerXml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid EPUB: META-INF/container.xml is not valid XML');
  }

  const rootfile = findByLocalName(doc, 'rootfile')[0];
  const fullPath = rootfile?.getAttribute('full-path');
  if (!fullPath) {
    throw new Error('Invalid EPUB: container.xml has no rootfile full-path');
  }
  return fullPath;
}

interface ManifestItem {
  href: string;
  mediaType: string;
}

function parseOpf(opfXml: string, opfDir: string): { manifest: Map<string, ManifestItem>; spineHrefs: string[] } {
  const doc = new DOMParser().parseFromString(opfXml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid EPUB: OPF file is not valid XML');
  }

  const manifest = new Map<string, ManifestItem>();
  for (const el of findByLocalName(doc, 'item')) {
    const id = el.getAttribute('id');
    const href = el.getAttribute('href');
    if (!id || !href) continue;
    manifest.set(id, {
      href: resolveRelativePath(opfDir, href),
      mediaType: el.getAttribute('media-type') ?? '',
    });
  }

  // Non-linear spine items (EPUB3 footnote/pop-up content not meant for the
  // main reading order) are deliberately excluded from continuous scroll.
  const spineHrefs: string[] = [];
  for (const el of findByLocalName(doc, 'itemref')) {
    if (el.getAttribute('linear') === 'no') continue;
    const idref = el.getAttribute('idref');
    const item = idref ? manifest.get(idref) : undefined;
    if (item) spineHrefs.push(item.href);
  }

  return { manifest, spineHrefs };
}

function extractTitle(opfXml: string): string | null {
  const doc = new DOMParser().parseFromString(opfXml, 'application/xml');
  const titleEl = findByLocalName(doc, 'title')[0];
  const text = titleEl?.textContent?.trim();
  return text || null;
}

/**
 * Strips everything from a chapter's markup that could fight our own
 * font/size/line-height/theme controls or break out of the app, while
 * preserving real structure (paragraphs, headings, emphasis, images):
 * - <script> removed outright.
 * - <a href> neutralized - footnote/cross-chapter links are meaningless
 *   once chapters are concatenated into one document, and left alone they
 *   could navigate the WebView somewhere broken.
 * - on* event handler attributes removed.
 * - <img src> rewritten to the pre-extracted data: URI for that image.
 * - SVG-wrapped images (<svg><image xlink:href="..."/></svg>, the
 *   standard cover-page/full-bleed-illustration pattern from Calibre,
 *   Sigil, and most other EPUB tools) get the same src-rewriting
 *   treatment via whichever of xlink:href/href they carry - <img> alone
 *   missed this entirely, leaving covers built this way blank.
 * - inline style attributes kept, but with font/color/background
 *   properties stripped out (those are exactly the properties our own
 *   theme/font controls need to own).
 * The chapter's own <head> (its <link rel="stylesheet"> and <style>
 * tags) is discarded entirely by only reading .body - this is what stops
 * the EPUB's own CSS from ever being loaded in the first place.
 */
function sanitizeChapterHtml(rawHtml: string, chapterDir: string, imageDataUris: Map<string, string>): string {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

  doc.querySelectorAll('script').forEach((el) => el.remove());
  doc.querySelectorAll('a[href]').forEach((a) => a.removeAttribute('href'));

  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src');
    if (!src) return;
    const resolved = resolveRelativePath(chapterDir, src);
    const dataUri = imageDataUris.get(resolved);
    if (dataUri) {
      img.setAttribute('src', dataUri);
    } else {
      img.removeAttribute('src');
    }
  });

  // querySelectorAll('image') only ever matches SVG <image> elements -
  // "image" isn't a valid HTML tag name, so there's no risk of matching
  // something else. SVG <image> can carry either the legacy xlink:href or
  // the SVG2 plain href; whichever is present gets rewritten the same way.
  doc.querySelectorAll('image').forEach((image) => {
    const attrName = image.hasAttribute('xlink:href') ? 'xlink:href' : image.hasAttribute('href') ? 'href' : null;
    if (!attrName) return;
    const href = image.getAttribute(attrName);
    if (!href) return;
    const resolved = resolveRelativePath(chapterDir, href);
    const dataUri = imageDataUris.get(resolved);
    if (dataUri) {
      image.setAttribute(attrName, dataUri);
    } else {
      image.removeAttribute(attrName);
    }
  });

  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    }

    const style = el.getAttribute('style');
    if (!style) return;
    const kept = style
      .split(';')
      .map((decl) => decl.trim())
      .filter(Boolean)
      .filter((decl) => !STRIPPED_INLINE_STYLE_PROPS.has(decl.split(':')[0]?.trim().toLowerCase() ?? ''))
      .join('; ');

    if (kept) el.setAttribute('style', kept);
    else el.removeAttribute('style');
  });

  return doc.body?.innerHTML ?? '';
}

export async function parseEpub(base64: string, fallbackTitle: string): Promise<ParsedEpub> {
  const zip = await JSZip.loadAsync(base64, { base64: true });

  const containerEntry = zip.file('META-INF/container.xml');
  if (!containerEntry) {
    throw new Error('Not a valid EPUB: missing META-INF/container.xml');
  }
  const opfPath = findOpfPath(await containerEntry.async('string'));

  const opfEntry = zip.file(opfPath);
  if (!opfEntry) {
    throw new Error(`Not a valid EPUB: OPF file not found at ${opfPath}`);
  }
  const opfXml = await opfEntry.async('string');
  const opfDir = dirOf(opfPath);

  const { manifest, spineHrefs } = parseOpf(opfXml, opfDir);
  const title = extractTitle(opfXml) || fallbackTitle;

  const imageDataUris = new Map<string, string>();
  for (const item of manifest.values()) {
    if (!item.mediaType.startsWith('image/')) continue;
    const entry = zip.file(item.href);
    if (!entry) continue;
    const base64Data = await entry.async('base64');
    imageDataUris.set(item.href, `data:${item.mediaType};base64,${base64Data}`);
  }

  const chaptersHtml: string[] = [];
  for (const href of spineHrefs) {
    const entry = zip.file(href);
    if (!entry) continue;
    const rawHtml = await entry.async('string');
    chaptersHtml.push(sanitizeChapterHtml(rawHtml, dirOf(href), imageDataUris));
  }

  if (chaptersHtml.length === 0) {
    throw new Error('No readable chapters found in this EPUB');
  }

  return { title, chaptersHtml };
}
