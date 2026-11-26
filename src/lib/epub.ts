import JSZip from 'jszip';
import DOMPurify from 'dompurify';
import { ImageStore, isOwnBlobUrl, type RegisteredImage } from './imageProcessor';
import { dirOf, resolveRelativePath } from './epubPath';
import { loadEpubToc } from './epubToc';
import { ANCHOR_ATTR, type TocItem } from './toc';

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

function localName(el: Element): string {
  return el.localName || el.tagName.split(':').pop() || el.tagName;
}

function findByLocalName(doc: Document, name: string): Element[] {
  return Array.from(doc.getElementsByTagName('*')).filter((el) => localName(el) === name);
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
  /** The item's `properties` attribute (EPUB 3), e.g. "nav" or "cover-image". */
  properties: string;
}

interface ParsedOpf {
  manifest: Map<string, ManifestItem>;
  /** The reading order: spine items that are linear. */
  spineHrefs: string[];
  /** Every spine item, in order, linear or not. */
  fullSpineHrefs: string[];
  /** The EPUB 3 navigation document, if declared. */
  navHref: string | null;
  /** The EPUB 2 NCX, if declared. */
  ncxHref: string | null;
}

function parseOpf(opfXml: string, opfDir: string): ParsedOpf {
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
      properties: el.getAttribute('properties') ?? '',
    });
  }

  // Non-linear spine items (EPUB3 footnote/pop-up content not meant for the
  // main reading order) are deliberately excluded from continuous scroll.
  const spineHrefs: string[] = [];
  const fullSpineHrefs: string[] = [];
  for (const el of findByLocalName(doc, 'itemref')) {
    const idref = el.getAttribute('idref');
    const item = idref ? manifest.get(idref) : undefined;
    if (!item) continue;
    fullSpineHrefs.push(item.href);
    if (el.getAttribute('linear') === 'no') continue;
    spineHrefs.push(item.href);
  }

  // The table-of-contents documents: EPUB 3 marks its nav with properties="nav";
  // EPUB 2 names the NCX in <spine toc="id"> (or just gives it its own media type).
  let navHref: string | null = null;
  let ncxHref: string | null = null;
  for (const item of manifest.values()) {
    if (navHref === null && item.properties.split(/\s+/).includes('nav')) navHref = item.href;
    if (ncxHref === null && item.mediaType === 'application/x-dtbncx+xml') ncxHref = item.href;
  }
  const spineEl = findByLocalName(doc, 'spine')[0];
  const tocId = spineEl?.getAttribute('toc');
  const declaredNcx = tocId ? manifest.get(tocId) : undefined;
  if (declaredNcx) ncxHref = declaredNcx.href;

  return { manifest, spineHrefs, fullSpineHrefs, navHref, ncxHref };
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
const ALLOWED_ATTR = ['alt', 'src', 'width', 'height', 'colspan', 'rowspan', 'lang', 'dir', 'style', 'loading', 'decoding', 'data-vach-anchor', 'data-vach-link'];

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

// Style the reader itself stamps on an <img> (see stampImage) so loading never
// moves the text: its size, the aspect ratio that reserves its height, and -
// for a small image sitting inside a line of text - inline placement. Allowed
// on <img> ONLY; on any other element these are as forbidden as before.
const IMAGE_STYLE_PROPS = new Set(['width', 'aspect-ratio', 'display', 'vertical-align']);

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
    case 'width':
      return /^\d{1,6}px$/.test(v);
    case 'aspect-ratio':
      return /^\d{1,6}(\.\d+)?\s*\/\s*\d{1,6}(\.\d+)?$/.test(v);
    case 'display':
      return /^(inline|inline-block)$/i.test(v);
    case 'vertical-align':
      return /^(baseline|middle|top|bottom|text-top|text-bottom)$/i.test(v);
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

function sanitizeStyleAttr(style: string, isImage = false): string {
  return style
    .split(';')
    .map((decl) => decl.trim())
    .filter(Boolean)
    .map((decl) => {
      const idx = decl.indexOf(':');
      if (idx === -1) return null;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      const value = decl.slice(idx + 1).trim();
      if (!(ALLOWED_STYLE_PROPS.has(prop) || (isImage && IMAGE_STYLE_PROPS.has(prop))) || !isSafeStyleValue(prop, value)) return null;
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
// must only ever be a blob: URL that THIS APP created for an image from the
// book's own archive (imageProcessor.ts keeps the list; a URL is on it from
// the moment it is made until the book closes). A book cannot name one it was
// not handed. Anything else - a relative path that survived unresolved,
// http(s):, javascript:, data: of any kind - is dropped, and so is a blob: URL
// from anywhere else. ALLOWED_URI_REGEXP enforces the blob: scheme at the
// DOMPurify-config level as a second, independent check.
// Publishers hard-code table geometry (<table width="800">, <td width="120">,
// <col width=...>). Left in, it fights the reader's own table layout - a
// fixed width wider than the screen is exactly what makes a table overflow -
// so it is dropped at the source. (<img width/height> is not touched here.)
const TABLE_GEOMETRY_NODES = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'COL', 'COLGROUP', 'CAPTION']);

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if ((data.attrName === 'width' || data.attrName === 'height') && TABLE_GEOMETRY_NODES.has(node.nodeName)) {
    data.keepAttr = false;
    return;
  }
  if (data.attrName === 'style') {
    data.attrValue = sanitizeStyleAttr(data.attrValue, node.nodeName === 'IMG');
    if (!data.attrValue) data.keepAttr = false;
    return;
  }
  if (data.attrName === 'src' && node.nodeName === 'IMG' && !isOwnBlobUrl(data.attrValue)) {
    data.keepAttr = false;
    return;
  }
  // The only values the reader itself ever stamps; a book's own are not kept.
  if (data.attrName === 'loading' && !(node.nodeName === 'IMG' && data.attrValue === 'lazy')) data.keepAttr = false;
  if (data.attrName === 'decoding' && !(node.nodeName === 'IMG' && data.attrValue === 'async')) data.keepAttr = false;
});

const DOMPURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP: /^blob:/i,
  // DOMPurify checks every allowed attribute's *value* against
  // ALLOWED_URI_REGEXP, not just URI-bearing ones - any attribute whose name
  // isn't in its own small built-in uri-safe list (alt, style, a few others)
  // falls through to that check too, and our regexp is deliberately narrow
  // (only "blob:..." - fine for src, nonsensical for a number or a language
  // code). Without this, width/height/colspan/rowspan/lang/dir were silently
  // dropped whenever their value didn't start with the allowed scheme - found
  // via a regression test that actually asserted colspan survived a real
  // sanitize() round trip. src is deliberately not in this list: it's the one
  // attribute that must keep going through the regexp check (and the hook).
  ADD_URI_SAFE_ATTR: ['width', 'height', 'colspan', 'rowspan', 'lang', 'dir', 'loading', 'decoding', 'data-vach-anchor', 'data-vach-link'],
  ALLOW_DATA_ATTR: false,
  // Explicit on top of the allowlist default-deny, so the intent reads
  // clearly even though these are already absent from ALLOWED_TAGS: no
  // script/active content, no additional stylesheets or navigation, no SVG
  // or MathML (and nothing from either namespace sneaks in disguised as
  // HTML; foreign content gets the same tag/attribute checks regardless of
  // namespace).
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'meta', 'link', 'base', 'style', 'svg'],
};

export type ResolveImage = (resolvedHref: string) => Promise<RegisteredImage | null>;

const INLINE_TEXT_TAGS = new Set(['SPAN', 'EM', 'STRONG', 'I', 'B', 'U', 'S', 'SUB', 'SUP', 'SMALL', 'CODE', 'RUBY', 'RT', 'RP', 'DEL', 'INS', 'A']);

/** Is this image part of a line of text (a small glyph or icon among words), rather than a picture standing on its own? */
function isInTextFlow(img: Element): boolean {
  const parent = img.parentElement;
  if (!parent) return false;
  return Array.from(parent.childNodes).some((node) => {
    if (node === img) return false;
    if (node.nodeType === 3) return (node.textContent ?? '').trim().length > 0;
    return node.nodeType === 1 && INLINE_TEXT_TAGS.has((node as Element).tagName) && (node.textContent ?? '').trim().length > 0;
  });
}

/**
 * Puts what loading needs onto an <img> BEFORE it mounts: its blob: src, its
 * intrinsic size as width/height, and an aspect-ratio, so the browser reserves
 * the exact box and the text around it never moves when the picture arrives.
 * (The width is explicit, not left to the image, because the placeholder shown
 * until a big image is downscaled is 1x1 and would otherwise size the box.)
 * loading=lazy and decoding=async keep far-off pictures from being decoded early.
 * A book's own width/height/style on the tag are replaced by these.
 */
function stampImage(img: Element, info: RegisteredImage): void {
  img.setAttribute('src', info.url);
  img.setAttribute('loading', 'lazy');
  img.setAttribute('decoding', 'async');

  const style: string[] = [];
  if (info.width && info.height) {
    img.setAttribute('width', String(info.width));
    img.setAttribute('height', String(info.height));
    style.push(`width: ${info.width}px`, `aspect-ratio: ${info.width} / ${info.height}`);
  } else {
    img.removeAttribute('width');
    img.removeAttribute('height');
  }
  if (isInTextFlow(img)) style.push('display: inline-block', 'vertical-align: middle', 'margin: 0 0.15em');
  if (style.length > 0) img.setAttribute('style', style.join('; '));
  else img.removeAttribute('style');
}

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
async function convertSvgImagesToImg(doc: Document, chapterDir: string, resolveImage: ResolveImage): Promise<void> {
  for (const image of Array.from(doc.querySelectorAll('image'))) {
    const attrName = image.hasAttribute('xlink:href') ? 'xlink:href' : image.hasAttribute('href') ? 'href' : null;
    const href = attrName ? image.getAttribute(attrName) : null;
    const info = href ? await resolveImage(resolveRelativePath(chapterDir, href)) : null;

    if (info) {
      const img = doc.createElement('img');
      image.replaceWith(img);
      stampImage(img, info);
    } else {
      image.remove();
    }
  }
}

/** A small, fast, non-cryptographic hash (FNV-1a) - only to tell one embedded picture from another. */
function hashString(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const INLINE_DATA_IMAGE = /^data:(image\/[a-z0-9.+-]+)(;base64)?,/i;

/** Bytes of a data:image/... URI a book embedded in its own markup, or null if it is not one (or is too large). */
function decodeInlineImage(src: string): { bytes: Uint8Array; mediaType: string } | null {
  const match = INLINE_DATA_IMAGE.exec(src);
  if (!match || !match[2]) return null;
  const payload = src.slice(match[0].length);
  if (payload.length > (MAX_IMAGE_UNCOMPRESSED_BYTES * 4) / 3) return null;
  try {
    return { bytes: Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)), mediaType: match[1].toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Resolves every <img src> to the app's own blob: URL for that image (via
 * resolveImage, which reads it from the archive) and stamps it (stampImage).
 * An image that doesn't resolve to a real manifest image loses its src. This
 * is - with convertSvgImagesToImg - the one place an <img src> that survives
 * the sanitizer is produced, which is what the DOMPurify hook above is trusting.
 */
async function resolveImgSrcs(
  doc: Document,
  chapterDir: string,
  resolveImage: ResolveImage,
  registerInline: (bytes: Uint8Array, mediaType: string, key: string) => RegisteredImage,
): Promise<void> {
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src');
    // Already resolved (convertSvgImagesToImg produced this <img> itself).
    // Re-running it through resolveRelativePath would treat the URL's own
    // text as a zip-relative path and mangle it into a lookup miss.
    if (src && isOwnBlobUrl(src)) continue;

    let info: RegisteredImage | null = null;
    if (src) {
      const inline = decodeInlineImage(src);
      info = inline ? registerInline(inline.bytes, inline.mediaType, `inline:${src.length}:${hashString(src)}`) : await resolveImage(resolveRelativePath(chapterDir, src));
    }
    if (info) {
      stampImage(img, info);
    } else {
      // Nothing to show: no src, and none of the book's own geometry or styling kept either.
      img.removeAttribute('src');
      img.removeAttribute('style');
    }
  }
}

/**
 * Parses a chapter's raw markup, resolves its images to blob: URLs, and
 * runs the result through DOMPurify's default-deny allowlist (see
 * DOMPURIFY_CONFIG above) rather than trying to enumerate everything
 * dangerous. The chapter's own <head> (its <link rel="stylesheet"> and
 * <style> tags) is discarded entirely by only reading .body - and <style>/
 * <link> are forbidden outright by DOMPurify too, as defense in depth.
 */
// Where a table-of-contents entry points inside a chapter ("ch1.xhtml#part2"),
// so the reader can scroll there. A book's own ids (and <a name>) are NOT
// allowed through - they could clobber the page's own names - so each is kept
// as the inert data attribute ANCHOR_ATTR (toc.ts) instead, which nothing reads except the jump.
const MAX_ANCHOR_LENGTH = 200;
const ALLOWED_TAG_SET = new Set(ALLOWED_TAGS.map((tag) => tag.toUpperCase()));

/**
 * Moves every id / <a name> onto ANCHOR_ATTR on an element that will survive
 * sanitizing. It only ever changes an attribute, never the tree, so the
 * chapter's block structure - which saved reading positions are counted in -
 * is exactly what it was. An anchor on an element the allowlist drops (the
 * usual empty <a id="x"></a> inside a heading) is handed to the nearest
 * surviving ancestor, or at the top level to the next element.
 */
function keepAnchors(doc: Document): void {
  const body = doc.body;
  if (!body) return;
  for (const el of Array.from(body.querySelectorAll('[id], a[name]'))) {
    const value = el.getAttribute('id') ?? el.getAttribute('name') ?? '';
    el.removeAttribute('id');
    if (!value || value.length > MAX_ANCHOR_LENGTH) continue;

    let holder: Element | null = el;
    if (!ALLOWED_TAG_SET.has(el.tagName)) {
      holder = el.parentElement;
      while (holder && holder !== body && !ALLOWED_TAG_SET.has(holder.tagName)) holder = holder.parentElement;
      if (holder === body || !holder) {
        holder = el.nextElementSibling;
        while (holder && !ALLOWED_TAG_SET.has(holder.tagName)) holder = holder.nextElementSibling;
      }
    }
    if (holder && !holder.hasAttribute(ANCHOR_ATTR)) holder.setAttribute(ANCHOR_ATTR, value);
  }
}

/**
 * One chapter's untrusted markup -> the sanitized HTML the reader mounts: images resolved through the book's
 * ImageStore (sized before mount), ids kept as inert anchors, then the default-deny allowlist. Used for EPUB
 * chapters and, with `prepare`, for Word documents (docx.ts), whose own markup is just as untrusted.
 * `prepare` may reshape the parsed document first (docx.ts turns internal links into tappable spans).
 */
export async function sanitizeChapterHtml(
  rawHtml: string,
  chapterDir: string,
  resolveImage: ResolveImage,
  registerInline: (bytes: Uint8Array, mediaType: string, key: string) => RegisteredImage,
  prepare?: (doc: Document) => void,
): Promise<string> {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  prepare?.(doc);

  await convertSvgImagesToImg(doc, chapterDir, resolveImage);
  await resolveImgSrcs(doc, chapterDir, resolveImage, registerInline);
  keepAnchors(doc);

  return sanitizePlainFragment(doc.body?.innerHTML ?? '');
}

/**
 * The same default-deny allowlist pass as sanitizeChapterHtml above, minus
 * the EPUB-specific image-resolution step - for markup that was never built
 * from an untrusted zip entry in the first place (pdf.ts's reconstructed
 * page text, built entirely via escapeHtml()) but is routed through this
 * anyway as defense in depth, per the same "default-deny, not a place to
 * special-case one caller as exempt" reasoning as the rest of this file.
 * Shared with pdf.ts rather than duplicated, so there's one allowlist and
 * one style-sanitizer, not two copies to keep in sync.
 *
 * Wide tables and <pre> blocks are no longer wrapped in a scrolling box here:
 * tables are adapted to the screen after mount (tableAdapter.ts) and <pre>
 * wraps in CSS, so nothing needs a sideways-scrolling container.
 */
export function sanitizePlainFragment(rawHtml: string): string {
  return DOMPurify.sanitize(rawHtml, DOMPURIFY_CONFIG);
}

/**
 * Same allowlist and sanitize() call as sanitizePlainFragment, for content
 * that only ever contains <h2>/<p> built through escapeHtml() (pdf.ts's
 * reconstructed page text, see reconstructPage). Kept as its own name so
 * that caller states what it relies on.
 */
export function sanitizePlainTextOnly(rawHtml: string): string {
  return DOMPurify.sanitize(rawHtml, DOMPURIFY_CONFIG);
}

/**
 * What the EPUB reader needs from a ZIP: existence checks and capped entry
 * reads. Two implementations exist - JSZip over an in-memory archive (small
 * EPUBs) and zipReader.ts over byte ranges (large ones) - and everything
 * below is written against this, so a book behaves identically either way.
 */
export interface EpubArchive {
  has(path: string): boolean;
  /** Reads one entry's decompressed bytes; rejects if missing or over `maxBytes` of real output. */
  read(path: string, maxBytes: number): Promise<Uint8Array>;
  /**
   * An entry's uncompressed size as recorded in the ZIP's central directory,
   * without reading it; undefined if unknown. Used to weight reading progress.
   */
  sizeOf?(path: string): number | undefined;
}

export function archiveFromJSZip(zip: JSZip): EpubArchive {
  return {
    has: (path) => zip.file(path) !== null,
    // jszip keeps each entry's central-directory size in a private field; if a
    // future version moves it, sizes read as unknown and progress counts chapters equally.
    sizeOf: (path) => {
      const size = (zip.file(path) as unknown as { _data?: { uncompressedSize?: unknown } } | null)?._data?.uncompressedSize;
      return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : undefined;
    },
    read: (path, maxBytes) => {
      const entry = zip.file(path);
      if (!entry) return Promise.reject(new Error(`Entry "${path}" not found in the archive`));
      return readEntryBytesCapped(entry, maxBytes);
    },
  };
}

/**
 * An opened EPUB with random access to its chapters. Opening reads only the
 * container, OPF and spine - no chapter is decompressed or sanitized until
 * loadChapter() asks for it, which is what lets the reader start at a saved
 * chapter without parsing the ones before it.
 */
export interface EpubBook {
  title: string;
  /**
   * Number of chapters, in reading order. A chapter's index here is the
   * `chapterIndex` stored in a saved reading position. Spine entries that
   * don't exist in the archive are dropped, matching what the reader has
   * always done, so indexes line up with previously saved positions.
   */
  chapterCount: number;
  /** Sanitized HTML for chapter `index`. Never rejects for a bad chapter: that yields an error placeholder, as before. */
  loadChapter(index: number): Promise<string>;
  /** Title and total, then chapters `startIndex`..end in order. */
  stream(startIndex?: number): AsyncGenerator<ParseEvent>;
  /**
   * The table of contents, mapped onto chapter indexes. Reads only the book's
   * navigation file (once, then cached), never a chapter. A book with no
   * usable TOC gets one "Section N" entry per chapter.
   */
  toc(): Promise<TocItem[]>;
  /**
   * Each chapter's uncompressed size in bytes, from the ZIP index (no parsing),
   * by chapter index - what reading progress is weighted by. Null if the
   * archive cannot say.
   */
  chapterWeights: readonly number[] | null;
  /**
   * Where an internal link's target lives (a Word document's footnote, a cross-reference): the chapter and the
   * anchor in it. Only books whose links are tappable provide it; an EPUB's links are not (yet).
   */
  resolveLink?(anchorId: string): { chapterIndex: number; fragment: string } | null;
  /** The book's images: sizes, background downscaling, full-detail decoding for the lightbox. */
  images: ImageStore;
  /** Releases everything the book holds (every blob: URL). Call when the book closes. */
  close(): void;
}

/**
 * Opens an EPUB from an archive: reads the container, OPF and spine, and
 * returns a book whose chapters are loaded on demand (see EpubBook).
 */
export async function openEpub(archive: EpubArchive, fallbackTitle: string): Promise<EpubBook> {
  if (!archive.has('META-INF/container.xml')) {
    throw new Error('Not a valid EPUB: missing META-INF/container.xml');
  }
  const decoder = new TextDecoder();
  const opfPath = findOpfPath(decoder.decode(await archive.read('META-INF/container.xml', MAX_CHAPTER_UNCOMPRESSED_BYTES)));

  if (!archive.has(opfPath)) {
    throw new Error(`Not a valid EPUB: OPF file not found at ${opfPath}`);
  }
  const opfXml = decoder.decode(await archive.read(opfPath, MAX_CHAPTER_UNCOMPRESSED_BYTES));
  const opfDir = dirOf(opfPath);

  const { manifest, spineHrefs, fullSpineHrefs, navHref, ncxHref } = parseOpf(opfXml, opfDir);
  const title = extractTitle(opfXml) || fallbackTitle;

  // Known up front, from the spine and the archive's own index: a progress
  // fraction and "chapter N of M" exist immediately, and chapter indexes
  // stay valid without parsing anything.
  const chapterHrefs = spineHrefs.filter((href) => archive.has(href));
  if (chapterHrefs.length === 0) {
    throw new Error('No readable chapters found in this EPUB');
  }

  // Sizes straight from the ZIP index - nothing is read or parsed for them.
  const sizes = archive.sizeOf ? chapterHrefs.map((href) => archive.sizeOf!(href)) : null;
  const chapterWeights = sizes && sizes.every((size): size is number => size !== undefined) ? sizes : null;

  let tocPromise: Promise<TocItem[]> | null = null;
  const toc = () =>
    (tocPromise ??= loadEpubToc({ archive, navPath: navHref, ncxPath: ncxHref, chapterPaths: chapterHrefs, fullSpinePaths: fullSpineHrefs }));

  const manifestByHref = new Map<string, ManifestItem>();
  for (const item of manifest.values()) {
    manifestByHref.set(item.href, item);
  }

  // One store per open book. Cached across chapters so an image shared by
  // multiple chapters (a repeated decorative asset, say) is only read once,
  // while still never touching an image the current chapter doesn't reference.
  const images = new ImageStore();
  const imageCache = new Map<string, RegisteredImage | null>();
  async function resolveImage(resolvedHref: string): Promise<RegisteredImage | null> {
    if (imageCache.has(resolvedHref)) return imageCache.get(resolvedHref) ?? null;
    const item = manifestByHref.get(resolvedHref);
    if (!item?.mediaType.startsWith('image/') || !archive.has(resolvedHref)) {
      imageCache.set(resolvedHref, null);
      return null;
    }
    try {
      const bytes = await archive.read(resolvedHref, MAX_IMAGE_UNCOMPRESSED_BYTES);
      // The store keeps only a way to read the entry again later (for the
      // downscale and the lightbox), never the original bytes.
      const info = images.register(resolvedHref, bytes, item.mediaType, {
        read: () => archive.read(resolvedHref, MAX_IMAGE_UNCOMPRESSED_BYTES),
      });
      imageCache.set(resolvedHref, info);
      return info;
    } catch (err) {
      // Same treatment as an image that doesn't resolve at all - drop it,
      // don't take the whole chapter down over one oversized/corrupt image.
      console.error('[epub] image exceeded size cap or failed to decompress, dropping', resolvedHref, err);
      imageCache.set(resolvedHref, null);
      return null;
    }
  }

  // A picture embedded in the chapter's own markup as a data: URI: its bytes are
  // already in memory (they are the markup), so they are what the store re-reads.
  function registerInline(bytes: Uint8Array, mediaType: string, key: string): RegisteredImage {
    return images.register(key, bytes, mediaType, { read: async () => bytes });
  }

  async function loadChapter(index: number): Promise<string> {
    const href = chapterHrefs[index];
    if (href === undefined) throw new RangeError(`No chapter ${index} (this book has ${chapterHrefs.length})`);
    try {
      const bytes = await archive.read(href, MAX_CHAPTER_UNCOMPRESSED_BYTES);
      return await sanitizeChapterHtml(decoder.decode(bytes), dirOf(href), resolveImage, registerInline);
    } catch (err) {
      console.error('[epub] failed to parse chapter', href, err);
      return '<p class="chapter-error">[This chapter could not be loaded]</p>';
    }
  }

  return {
    title,
    chapterCount: chapterHrefs.length,
    loadChapter,
    toc,
    chapterWeights,
    images,
    close: () => images.revokeAll(),
    async *stream(startIndex = 0) {
      yield { type: 'title', title };
      yield { type: 'total', count: chapterHrefs.length };
      for (let i = Math.max(0, startIndex); i < chapterHrefs.length; i++) {
        yield { type: 'chapter', html: await loadChapter(i) };
      }
    },
  };
}

/**
 * Streams an EPUB's title and chapters as they become available, instead of
 * fully parsing the book before returning anything - from an in-memory
 * archive. (The reader opens books through epubFile.ts and EpubBook.stream();
 * this whole-archive form is kept for callers that already hold the bytes.)
 */
export async function* streamEpub(bytes: Uint8Array, fallbackTitle: string): AsyncGenerator<ParseEvent> {
  const zip = await JSZip.loadAsync(bytes);
  const book = await openEpub(archiveFromJSZip(zip), fallbackTitle);
  yield* book.stream(0);
}
