// Word (.docx) -> HTML plus the document's pictures as bytes. This is the heavy part (mammoth and a ZIP reader), so
// nothing imports it statically: it runs inside docxWorker.ts, off the main thread, and is only loaded when a .docx
// is opened. It touches no DOM - mammoth parses XML with @xmldom/xmldom - which is what lets it run in a Worker.
// Everything it returns is untrusted: the reader puts it through the same sanitizer as an EPUB chapter.

import mammoth from 'mammoth';
import JSZip from 'jszip';
import { DocxError } from './docxError';
import { DOCX_IMAGE_SCHEME, type ConvertedImage, type DocxConversion } from './docxTypes';

export { DOCX_IMAGE_SCHEME };
export type { ConvertedImage, DocxConversion };

// Pictures a WebView can draw. Word also embeds EMF/WMF/TIFF, which it cannot: those are left out, with a warning.
const RENDERABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp']);

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Checks the first bytes before spending any time on the file. Throws a DocxError for what it can name. */
export function checkDocxHeader(bytes: Uint8Array): void {
  if (bytes.length < 4) throw new DocxError('corrupt');
  // An encrypted .docx is not a ZIP at all but an OLE compound file; so is a legacy binary .doc.
  if (OLE_MAGIC.every((value, i) => bytes[i] === value)) throw new DocxError('password-protected');
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new DocxError('not-docx');
}

/** The text of the first <dc:title> in core.xml, or null. */
export function titleFromCoreXml(xml: string): string | null {
  const match = /<dc:title(?:\s[^>]*)?>([\s\S]*?)<\/dc:title>/.exec(xml);
  if (!match) return null;
  const text = match[1]
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/** A 32-bit FNV-1a over all the bytes; with the length, enough to find identical pictures cheaply before comparing them. */
function fingerprint(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
  return `${bytes.length}:${hash}`;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * A plain Uint8Array with its own ArrayBuffer, so it can be transferred between threads without dragging a larger
 * buffer along (a Node Buffer's slice() is only a view). Copies unless the view already owns its whole buffer.
 */
function ownBytes(view: Uint8Array): Uint8Array {
  return view.constructor === Uint8Array && view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view : new Uint8Array(view);
}

/** mammoth's browser build reads an ArrayBuffer; its Node build (used by the tests) wants a Buffer. */
function mammothInput(buffer: ArrayBuffer) {
  return typeof Buffer === 'function' ? { buffer: Buffer.from(buffer) } : { arrayBuffer: buffer };
}

export async function convertDocx(input: ArrayBuffer): Promise<DocxConversion> {
  const header = new Uint8Array(input, 0, Math.min(8, input.byteLength));
  checkDocxHeader(header);

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input);
  } catch {
    throw new DocxError('corrupt');
  }
  if (!zip.file('word/document.xml')) throw new DocxError('not-docx');

  let title: string | null = null;
  try {
    const core = zip.file('docProps/core.xml');
    if (core) title = titleFromCoreXml(await core.async('string'));
  } catch {
    // A bad core.xml only costs the title.
  }

  const images: ConvertedImage[] = [];
  const byFingerprint = new Map<string, number[]>();
  const warnings: string[] = [];

  const convertImage = mammoth.images.imgElement(async (image) => {
    const contentType = (image.contentType ?? '').toLowerCase();
    if (!RENDERABLE_IMAGE_TYPES.has(contentType)) {
      warnings.push(`A picture of type ${contentType || 'unknown'} was left out (it cannot be shown here).`);
      return { src: '' };
    }
    const raw = await image.readAsArrayBuffer();
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
    // The same picture used twice in the document is kept once.
    const key = fingerprint(bytes);
    const candidates = byFingerprint.get(key) ?? [];
    for (const id of candidates) {
      const known = images[id - 1];
      if (known.contentType === contentType && sameBytes(known.bytes, bytes)) return { src: `${DOCX_IMAGE_SCHEME}${id}` };
    }
    const id = images.length + 1;
    images.push({ id, contentType, bytes: ownBytes(bytes) });
    byFingerprint.set(key, [...candidates, id]);
    return { src: `${DOCX_IMAGE_SCHEME}${id}` };
  });

  let result: Awaited<ReturnType<typeof mammoth.convertToHtml>>;
  try {
    result = await mammoth.convertToHtml(mammothInput(input), { convertImage });
  } catch (err) {
    if (err instanceof DocxError) throw err;
    console.error('[docx] mammoth failed', err);
    throw new DocxError('unreadable');
  }
  for (const message of result.messages) if (message.type === 'warning') warnings.push(message.message);
  return { html: result.value, images, title, warnings };
}
