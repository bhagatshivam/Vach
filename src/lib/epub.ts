import JSZip from 'jszip';
import DOMPurify from 'dompurify';

export type ParseEvent =
  | { type: 'title'; title: string }
  | { type: 'total'; count: number }
  | { type: 'chapter'; html: string };

// Generous for a real chapter (even a 10MB chapter of plain XHTML text is
// hundreds of thousands of words) but small enough to bound the cost of a
// pathological one - a zip bomb, or just a genuinely malformed/huge single
// entry - to a short, contained failure (the existing per-chapter error
// placeholder) instead of a multi-second main-thread stall.
const MAX_CHAPTER_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;

// Generous for even a very high-resolution cover/illustration, for the same
// reason. An oversized image is dropped (same as an unresolved one) rather
// than failing the whole chapter - one bad image shouldn't take the rest of
// the chapter's text down with it.
const MAX_IMAGE_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;

// jszip's internalStream() isn't in its published TypeScript types (its own
// type comment on the related, genuinely-private _data field even says so:
// "If/when it is made public this should be uncommented") but it's a real,
// non-underscore-prefixed prototype method - the same streaming primitive
// async() itself uses internally. This is a minimal structural type for the
// handful of methods used below.
interface JSZipStreamHelper {
  on(event: 'data', fn: (chunk: Uint8Array) => void): JSZipStreamHelper;
  on(event: 'error', fn: (err: Error) => void): JSZipStreamHelper;
  on(event: 'end', fn: () => void): JSZipStreamHelper;
  pause(): JSZipStreamHelper;
  resume(): JSZipStreamHelper;
}

/**
 * Reads a zip entry's full decompressed content as bytes, aborting as soon
 * as more than maxBytes has actually come out of the decompressor.
 *
 * Deliberately not a check of the zip's own declared "uncompressed size"
 * header: that number is just a field in the zip file, written by whoever
 * created it, and decompression doesn't stop just because the file lied
 * about it - trusting it isn't a real cap. Counting real bytes as they're
 * actually produced, via jszip's own internal streaming primitive, pausing
 * and rejecting the moment the cap is crossed, bounds actual memory and CPU
 * to roughly the cap regardless of what either a tiny on-disk size or a
 * dishonest header claims.
 */
function readEntryBytesCapped(entry: JSZip.JSZipObject, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const stream = (
      entry as unknown as { internalStream: (type: 'uint8array') => JSZipStreamHelper }
    ).internalStream('uint8array');
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;

    stream
      .on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          settled = true;
          stream.pause();
          reject(new Error(`Entry "${entry.name}" exceeds the ${maxBytes}-byte decompressed-size cap`));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(result);
      })
      .resume();
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

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

// ---------------------------------------------------------------------------
// Sanitization: default-deny allowlist (DOMPurify), not a blocklist.
//
// A hand-rolled walker (the previous approach) only ever stops the specific
// attack it was written against - a security audit of that approach kept
// finding one more unstripped tag (iframe, object, embed, base, meta, link,
// style, form, SVG's own xlink:href on <a>) because every one of those had
// to be individually remembered and blocked. DOMPurify inverts that: nothing
// survives unless it's explicitly allowed below, so a tag/attribute this
// list doesn't know about is already gone, not a future finding.
//
// Keep this list deliberately short. Adding to it is a deliberate, reviewed
// decision - not a place to paper over a rendering complaint by widening the
// allowlist first and asking questions later.
// ---------------------------------------------------------------------------

// Structural and text-formatting tags a light novel's chapter markup
// realistically uses, plus <img> (tightly constrained below - see
// ALLOWED_URI_REGEXP and the uponSanitizeAttribute hook). Deliberately
// excludes <a>: a stripped/neutralized link and no link at all read
// identically once rendered (neither is clickable), and DOMPurify's default
// behavior for a disallowed tag is to drop the tag but keep its text content,
// so footnote/cross-reference text still survives, just as inert text
// instead of an href-less anchor.
const ALLOWED_TAGS = [
  'p',
  'div',
  'span',
  'section',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'br',
  'hr',
  'em',
  'strong',
  'i',
  'b',
  'u',
  's',
  'del',
  'ins',
  'sub',
  'sup',
  'small',
  'blockquote',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'col',
  'figure',
  'figcaption',
  'pre',
  'code',
  'ruby',
  'rt',
  'rp',
  'img',
];

// No class/id: nothing in this app's own CSS targets chapter-content
// classes, so there's no legitimate use for them, and they're a classic
// vector for CSS-based tricks if that ever changes. style is kept but its
// *value* is independently re-validated below - this list only controls
// which attribute names can exist at all.
const ALLOWED_ATTR = ['alt', 'src', 'width', 'height', 'colspan', 'rowspan', 'lang', 'dir', 'style'];

// Inline style: a short allowlist of structural properties only - nothing
// that can paint, fetch, or navigate. Each property additionally has its
// *value* validated (see isSafeStyleValue) rather than merely being present,
// which is what actually closes the background-image network-leak finding:
// the property name is allowed in neither list, but even an allowed
// property's value is rejected outright if it contains parentheses at all,
// so a disguised url()/expression()/var()/calc() can't sneak in under a
// property name that looks safe.
const ALLOWED_STYLE_PROPS = new Set([
  'text-align',
  'text-indent',
  'font-style',
  'font-weight',
  'text-decoration',
  'margin',
  'margin-top',
  'margin-bottom',
  'margin-left',
  'margin-right',
]);

const LENGTH_OR_AUTO = /^(-?\d+(\.\d+)?(px|em|rem|%)?|auto)$/;

function isSafeStyleValue(prop: string, value: string): boolean {
  const v = value.trim();
  if (!v || /[(){}]/.test(v)) return false;
  switch (prop) {
    case 'text-align':
      return /^(left|right|center|justify)$/i.test(v);
    case 'text-indent':
      return /^-?\d+(\.\d+)?(px|em|rem|%)?$/.test(v);
    case 'font-style':
      return /^(normal|italic|oblique)$/i.test(v);
    case 'font-weight':
      return /^(normal|bold|bolder|lighter|[1-9]00)$/i.test(v);
    case 'text-decoration':
      return /^(none|underline|overline|line-through)(\s+(underline|overline|line-through))*$/i.test(v);
    case 'margin':
    case 'margin-top':
    case 'margin-bottom':
    case 'margin-left':
    case 'margin-right': {
      const tokens = v.split(/\s+/);
      return tokens.length >= 1 && tokens.length <= 4 && tokens.every((t) => LENGTH_OR_AUTO.test(t));
    }
    default:
      return false;
  }
}

function sanitizeStyleAttr(style: string): string {
  return style
    .split(';')
    .map((decl) => decl.trim())
    .filter(Boolean)
    .map((decl) => {
      const idx = decl.indexOf(':');
      if (idx === -1) return null;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      const value = decl.slice(idx + 1).trim();
      if (!ALLOWED_STYLE_PROPS.has(prop) || !isSafeStyleValue(prop, value)) return null;
      return `${prop}: ${value}`;
    })
    .filter((d): d is string => d !== null)
    .join('; ');
}

// Registered once at module load, not per-chapter - DOMPurify hooks are
// global to the module's DOMPurify instance, so adding one inside
// sanitizeChapterHtml would stack a duplicate on every call.
//
// img src is the only URI-bearing attribute this app allows at all, and it
// must only ever be a data: URI for an image - resolveImage() (below) is the
// only thing that ever produces one, from bytes this app itself decompressed
// out of the EPUB's own manifest. Anything else (a relative path that
// survived unresolved, http(s):, javascript:, data:text/html) is dropped.
// ALLOWED_URI_REGEXP enforces the same rule at the DOMPurify-config level as
// a second, independent check.
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'style') {
    data.attrValue = sanitizeStyleAttr(data.attrValue);
    if (!data.attrValue) data.keepAttr = false;
    return;
  }
  if (data.attrName === 'src' && node.nodeName === 'IMG' && !/^data:image\//i.test(data.attrValue)) {
    data.keepAttr = false;
  }
});

const DOMPURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP: /^data:image\//i,
  // DOMPurify checks every allowed attribute's *value* against
  // ALLOWED_URI_REGEXP, not just URI-bearing ones - any attribute whose name
  // isn't in its own small built-in uri-safe list (alt, style, a few others)
  // falls through to that check too, and our regexp is deliberately narrow
  // (only "data:image/..." - fine for src, nonsensical for a number or a
  // language code). Without this, width/height/colspan/rowspan/lang/dir were
  // silently dropped whenever their value didn't start with "data:image/" -
  // found via a regression test that actually asserted colspan survived a
  // real sanitize() round trip. src is deliberately not in this list: it's
  // the one attribute that must keep going through the regexp check.
  ADD_URI_SAFE_ATTR: ['width', 'height', 'colspan', 'rowspan', 'lang', 'dir'],
  ALLOW_DATA_ATTR: false,
  // Explicit on top of the allowlist default-deny, so the intent reads
  // clearly even though these are already absent from ALLOWED_TAGS: no
  // script/active content, no additional stylesheets or navigation, no SVG
  // or MathML (and nothing from either namespace sneaks in disguised as
  // HTML; foreign content gets the same tag/attribute checks regardless of
  // namespace).
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'meta', 'link', 'base', 'style', 'svg'],
};

/**
 * SVG-wrapped images (<svg><image xlink:href="..."/></svg>, the standard
 * cover-page/full-bleed-illustration pattern from Calibre, Sigil, and most
 * other EPUB tools) are pre-converted to plain <img> elements - reusing the
 * same resolveImage() lookup <img src> itself uses - before DOMPurify ever
 * runs, because SVG is forbidden outright afterward (SVG script/foreignObject/
 * CSS are exactly the kind of namespace-confusion surface a hand-rolled
 * walker gets wrong, and this app has no legitimate use for inline SVG).
 * DOMPurify's default behavior for a forbidden tag - remove the tag, keep
 * its children - unwraps the now-empty <svg>/<g> wrapper around the
 * replacement <img> for free.
 */
async function convertSvgImagesToImg(
  doc: Document,
  chapterDir: string,
  resolveImage: (resolvedHref: string) => Promise<string | null>,
): Promise<void> {
  for (const image of Array.from(doc.querySelectorAll('image'))) {
    const attrName = image.hasAttribute('xlink:href') ? 'xlink:href' : image.hasAttribute('href') ? 'href' : null;
    const href = attrName ? image.getAttribute(attrName) : null;
    const dataUri = href ? await resolveImage(resolveRelativePath(chapterDir, href)) : null;

    if (dataUri) {
      const img = doc.createElement('img');
      img.setAttribute('src', dataUri);
      const width = image.getAttribute('width');
      const height = image.getAttribute('height');
      if (width) img.setAttribute('width', width);
      if (height) img.setAttribute('height', height);
      image.replaceWith(img);
    } else {
      image.remove();
    }
  }
}

/**
 * Resolves <img src> to the pre-extracted data: URI for that image (or
 * drops the attribute if it doesn't resolve to a real manifest image) -
 * this is the one and only place a real data:image/* URI is ever produced,
 * which is what the DOMPurify hook above is trusting when it lets an <img
 * src> through.
 */
async function resolveImgSrcs(
  doc: Document,
  chapterDir: string,
  resolveImage: (resolvedHref: string) => Promise<string | null>,
): Promise<void> {
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src');
    // Already a resolved data: URI - either convertSvgImagesToImg produced
    // this <img> itself, or (defensively) some other earlier step did.
    // Re-running it through resolveRelativePath would treat the URI's own
    // text as a zip-relative path and mangle it into a lookup miss.
    if (!src || src.startsWith('data:')) continue;
    const dataUri = await resolveImage(resolveRelativePath(chapterDir, src));
    if (dataUri) {
      img.setAttribute('src', dataUri);
    } else {
      img.removeAttribute('src');
    }
  }
}

/**
 * Wraps every <table> and <pre> in DOMPurify's own sanitized output in a
 * <div class="scroll-x"> of our own creation, so a wide one (a many-column
 * table, a long unbreakable table cell, an ASCII-art status block) scrolls
 * inside its own bounded box instead of forcing the whole chapter - and with
 * it, the whole page - to scroll sideways (see .scroll-x in App.css).
 *
 * This runs on DOMPurify's already-sanitized fragment, using only elements
 * this function creates itself, so it can't reintroduce anything the
 * allowlist above was designed to keep out - no new tag or attribute is
 * added to ALLOWED_TAGS/ALLOWED_ATTR for this.
 */
function wrapWideElements(fragment: DocumentFragment): string {
  for (const el of Array.from(fragment.querySelectorAll('table, pre'))) {
    const wrapper = document.createElement('div');
    wrapper.className = 'scroll-x';
    el.replaceWith(wrapper);
    wrapper.appendChild(el);
  }

  const container = document.createElement('div');
  container.appendChild(fragment);
  return container.innerHTML;
}

/**
 * Parses a chapter's raw markup, resolves its images to data: URIs, and
 * runs the result through DOMPurify's default-deny allowlist (see
 * DOMPURIFY_CONFIG above) rather than trying to enumerate everything
 * dangerous. The chapter's own <head> (its <link rel="stylesheet"> and
 * <style> tags) is discarded entirely by only reading .body - and <style>/
 * <link> are forbidden outright by DOMPurify too, as defense in depth.
 */
async function sanitizeChapterHtml(
  rawHtml: string,
  chapterDir: string,
  resolveImage: (resolvedHref: string) => Promise<string | null>,
): Promise<string> {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

  await convertSvgImagesToImg(doc, chapterDir, resolveImage);
  await resolveImgSrcs(doc, chapterDir, resolveImage);

  return sanitizePlainFragment(doc.body?.innerHTML ?? '');
}

/**
 * The same default-deny allowlist pass as sanitizeChapterHtml above, minus
 * the EPUB-specific image-resolution step - for markup that was never built
 * from an untrusted zip entry in the first place (pdf.ts's reconstructed
 * page text, built entirely via escapeHtml()) but is routed through this
 * anyway as defense in depth, per the same "default-deny, not a place to
 * special-case one caller as exempt" reasoning as the rest of this file.
 * Shared with pdf.ts rather than duplicated, so there's one allowlist, one
 * style-sanitizer, one wrapWideElements - not two copies to keep in sync.
 */
export function sanitizePlainFragment(rawHtml: string): string {
  const fragment = DOMPurify.sanitize(rawHtml, {
    ...DOMPURIFY_CONFIG,
    RETURN_DOM_FRAGMENT: true,
  });
  return wrapWideElements(fragment);
}

/**
 * Streams an EPUB's title and chapters as they become available, instead of
 * fully parsing the book before returning anything. This lets ReaderScreen
 * show the first chapters as soon as they're ready and keep loading the
 * rest in the background - important for large books, where fully parsing
 * every chapter (and, previously, every image) up front could take minutes.
 */
export async function* streamEpub(base64: string, fallbackTitle: string): AsyncGenerator<ParseEvent> {
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
  yield { type: 'title', title };
  // Known from the spine alone, before any chapter is actually parsed - lets
  // a progress fraction and a "chapter N of M" restore indicator exist
  // immediately, not just once streaming finishes. A spine entry that fails
  // to resolve to a real zip file (skipped below, not yielded as a chapter)
  // means the true yielded-chapter count can end up slightly under this -
  // intentional: this is the book's own declared total, not a live count.
  yield { type: 'total', count: spineHrefs.length };

  const manifestByHref = new Map<string, ManifestItem>();
  for (const item of manifest.values()) {
    manifestByHref.set(item.href, item);
  }

  // Cached across chapters so an image shared by multiple chapters (a
  // repeated decorative asset, say) is only decompressed once, while still
  // never touching an image the current chapter doesn't reference.
  const imageCache = new Map<string, string | null>();
  async function resolveImage(resolvedHref: string): Promise<string | null> {
    if (imageCache.has(resolvedHref)) return imageCache.get(resolvedHref) ?? null;
    const item = manifestByHref.get(resolvedHref);
    const entry = item?.mediaType.startsWith('image/') ? zip.file(resolvedHref) : null;
    if (!entry) {
      imageCache.set(resolvedHref, null);
      return null;
    }
    try {
      const bytes = await readEntryBytesCapped(entry, MAX_IMAGE_UNCOMPRESSED_BYTES);
      const dataUri = `data:${item!.mediaType};base64,${bytesToBase64(bytes)}`;
      imageCache.set(resolvedHref, dataUri);
      return dataUri;
    } catch (err) {
      // Same treatment as an image that doesn't resolve at all - drop it,
      // don't take the whole chapter down over one oversized/corrupt image.
      console.error('[epub] image exceeded size cap or failed to decompress, dropping', resolvedHref, err);
      imageCache.set(resolvedHref, null);
      return null;
    }
  }

  let emitted = 0;
  for (const href of spineHrefs) {
    const entry = zip.file(href);
    if (!entry) continue;

    let html: string;
    try {
      const bytes = await readEntryBytesCapped(entry, MAX_CHAPTER_UNCOMPRESSED_BYTES);
      const rawHtml = new TextDecoder().decode(bytes);
      html = await sanitizeChapterHtml(rawHtml, dirOf(href), resolveImage);
    } catch (err) {
      console.error('[epub] failed to parse chapter', href, err);
      html = '<p class="chapter-error">[This chapter could not be loaded]</p>';
    }
    emitted++;
    yield { type: 'chapter', html };
  }

  if (emitted === 0) {
    throw new Error('No readable chapters found in this EPUB');
  }
}
