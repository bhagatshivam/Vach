import * as pdfjsLib from 'pdfjs-dist';
import { OPS, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
// `?url` is Vite's explicit static-asset import: it copies this file into
// the build output with a content hash and hands back that URL as a plain
// string, instead of trying to execute it as a module. This is what keeps
// the pdf.js worker fully local - verified against a real production build
// (no dev-server-only behavior) that this pulls in zero CDN/network
// references; pdf.js examples commonly load this worker from unpkg/cdnjs,
// which would silently violate this app's offline requirement.
//
// Points at this project's own tiny wrapper (pdfWorkerEntry.ts), not
// directly at pdfjs-dist's own worker file - the wrapper installs the
// Map.prototype.getOrInsertComputed polyfill inside the worker's own realm
// before pdf.worker.mjs's module body runs (see mapUpsertPolyfill.ts for
// why this is needed in real production Chromium, not just a sandbox
// quirk). Vite still fully bundles/hashes it like any other built module -
// `?url` isn't limited to pre-built/static files.
import pdfWorkerUrl from './pdfWorkerEntry.ts?worker&url';
import { sanitizePlainFragment } from './epub';
import { installMapUpsertPolyfill } from './mapUpsertPolyfill';

// Same polyfill, installed on the MAIN thread too: PDFPageProxy's own
// request-deduplication caches (e.g. the one getOperatorList/render check
// before ever messaging the worker) live here, in a separate JS realm from
// the worker - each needs its own copy of this method.
installMapUpsertPolyfill();

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type PageKind = 'text' | 'raster' | 'blank';

export type ParseEvent =
  | { type: 'title'; title: string }
  | { type: 'total'; count: number }
  | { type: 'chapter'; html: string; pageKind?: PageKind };

interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
  height: number;
  hasEOL: boolean;
}

function mode(numbers: number[]): number {
  const counts = new Map<number, number>();
  for (const n of numbers) counts.set(n, (counts.get(n) ?? 0) + 1);
  let best = numbers[0];
  let bestCount = 0;
  for (const [n, count] of counts) {
    if (count > bestCount) {
      best = n;
      bestCount = count;
    }
  }
  return best;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Reconstructs paragraph/heading structure from pdf.js's positioned text
 * items. Real extraction returns individual fragments with x/y coordinates,
 * not clean paragraphs, so this uses two independent signals - validated
 * against real extracted data, not guessed - to detect where a new
 * paragraph starts:
 *   - an unusually large vertical gap since the previous line (the
 *     blank-line style of paragraph separation), or
 *   - a first-line indent past the page's dominant left margin, on a line
 *     that follows a real line break (the more common novel-typesetting
 *     style: indent alone, no extra gap).
 * A line whose height is noticeably larger than the page's dominant
 * body-text height is treated as a heading instead of a paragraph.
 *
 * Returns '' for a page with no real text at all - callers decide what (if
 * anything) that means; this function doesn't itself render a placeholder
 * message. By construction (see classifyAndRenderPage below) this is only
 * ever reached for a page that's already been confirmed to have no
 * qualifying image/vector-art content either, so '' here means "genuinely
 * nothing to show", not "image page, skipped".
 */
function reconstructPage(items: PositionedTextItem[]): string {
  const clean = items.filter((item) => item.str.trim().length > 0);
  if (clean.length === 0) {
    return '';
  }

  const leftMargin = mode(clean.map((item) => Math.round(item.x)));
  const gaps: number[] = [];
  for (let i = 1; i < clean.length; i++) {
    gaps.push(Math.round(clean[i - 1].y - clean[i].y));
  }
  const positiveGaps = gaps.filter((gap) => gap > 0);
  const lineHeight = positiveGaps.length > 0 ? mode(positiveGaps) : 14;
  const bodyHeight = mode(clean.map((item) => Math.round(item.height)));

  type Block = { type: 'heading' | 'paragraph'; text: string };
  const blocks: Block[] = [];
  let current: Block | null = null;
  let prevItem: PositionedTextItem | null = null;

  for (const item of clean) {
    const text = item.str.trim();
    const isIndented = Math.round(item.x) > leftMargin + 5;
    const gapFromPrev = prevItem ? Math.round(prevItem.y - item.y) : null;
    const bigGap = gapFromPrev !== null && gapFromPrev > lineHeight * 1.35;
    const isHeading = Math.round(item.height) > bodyHeight * 1.2;
    const startsNewParagraph = current === null || bigGap || (isIndented && prevItem?.hasEOL === true);

    if (isHeading) {
      if (current) blocks.push(current);
      blocks.push({ type: 'heading', text });
      current = null;
    } else if (startsNewParagraph) {
      if (current) blocks.push(current);
      current = { type: 'paragraph', text };
    } else if (current) {
      current.text += ' ' + text;
    } else {
      current = { type: 'paragraph', text };
    }

    prevItem = item;
  }
  if (current) blocks.push(current);

  return blocks
    .map((block) => {
      const tag = block.type === 'heading' ? 'h2' : 'p';
      return `<${tag}>${escapeHtml(block.text)}</${tag}>`;
    })
    .join('\n');
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Textless-page classification.
//
// getTextContent() is already fetched for every page to reconstruct its
// text (unchanged from before this milestone), so counting non-whitespace
// characters from the items it returns costs nothing extra. getOperatorList
// - the only new, non-trivial call this adds - is gated behind that count:
// it only ever runs for a page with fewer than TEXTLESS_CHAR_THRESHOLD real
// characters, so a normal text page's per-page cost is unchanged.
// ---------------------------------------------------------------------------

const TEXTLESS_CHAR_THRESHOLD = 20;

// A page is classified as "mostly a picture" once a single image's
// displayed footprint covers more than this fraction of the page - chosen
// comfortably above half so a page with, say, one photo occupying the top
// 40% and a short caption underneath doesn't trip it, while a cover or
// full-bleed illustration (which in practice covers 90-100%) clearly does.
const IMAGE_COVERAGE_THRESHOLD = 0.55;

export type TextlessPageKind = 'image' | 'other' | 'none';

type Matrix = [number, number, number, number, number, number];

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

/** Composes two PDF content-stream matrices: applies `m` first, then `into`. */
function composeMatrix(m: Matrix, into: Matrix): Matrix {
  return [
    m[0] * into[0] + m[1] * into[2],
    m[0] * into[1] + m[1] * into[3],
    m[2] * into[0] + m[3] * into[2],
    m[2] * into[1] + m[3] * into[3],
    m[4] * into[0] + m[5] * into[2] + into[4],
    m[4] * into[1] + m[5] * into[3] + into[5],
  ];
}

/**
 * The area (in page user-space units²) that the unit square [0,1]×[0,1]
 * covers once transformed by `m` - i.e. the determinant of its linear part.
 * An image is always painted into that unit square by the time a paint op
 * runs, so this is exactly the image's displayed footprint, with no need to
 * know its intrinsic pixel size.
 */
function unitSquareArea(m: Matrix): number {
  return Math.abs(m[0] * m[3] - m[1] * m[2]);
}

const IMAGE_PAINT_OPS = new Set<number>([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintImageXObjectRepeat,
  OPS.paintInlineImageXObjectGroup,
]);

// Anything else that actually puts ink on the page (fills, strokes, shading,
// stencil/soft image masks used for bullets/logos/scanned bitonal content) -
// as opposed to state-setting ops (save/restore/transform/setFont/...) that
// never themselves paint anything. A page with only text ops below the char
// threshold and none of these is genuinely blank; a page with any of these
// but no single image over the coverage threshold is "vector art" and still
// worth rasterizing (e.g. a page-decoration border, a diagram, a logo too
// small/odd-shaped to read as a qualifying "image").
// Fill/stroke-family op codes - kept as a defensive fallback (see
// classifyTextlessPage's doc comment below for why these almost never
// actually appear as *standalone* fnArray entries in practice).
const OTHER_PAINT_OPS = new Set<number>([
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.stroke,
  OPS.closeStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
  OPS.shadingFill,
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageMaskXObjectRepeat,
  OPS.paintSolidColorImageMask,
  OPS.rawFillPath,
]);

/**
 * Classifies a textless (or near-textless) page by walking its operator
 * list once, tracking the current transformation matrix (via a save/
 * restore stack, same model the content stream itself uses) so an image
 * paint op's displayed coverage can be computed cheaply - O(operator
 * count), no canvas, no actual rendering. This is the "how is >55% image
 * coverage detected" answer: the matrix in effect at the moment of a
 * paintImageXObject-family op, applied to the unit square, gives the exact
 * parallelogram the image is drawn into; its area divided by the page's own
 * area (independent of rotation, since rotation preserves area) is the
 * coverage fraction.
 *
 * Vector art (a fill/stroke with no qualifying image) is detected via
 * OPS.constructPath, not via OPS.fill/OPS.stroke directly - confirmed
 * empirically against pdf.js's own operator list output: it consolidates a
 * content stream's path-construction operators *and* the terminal paint
 * operator that follows them (fill, stroke, fill-and-stroke, ...) into one
 * constructPath entry, whose own first argument carries which paint
 * variant it is - fill/stroke never show up as their own separate fnArray
 * entries for an ordinary painted path. A constructPath entry's presence
 * is therefore already "something was drawn" on its own; the separate
 * OTHER_PAINT_OPS check above is kept only as a defensive fallback for
 * whatever edge case might emit one of those standalone instead (none
 * observed in testing). Treating every constructPath as "paint" slightly
 * over-detects a purely-invisible clip-only path as vector art, but that's
 * a harmless false positive (rasterizing a page that's actually blank
 * looks the same as not rasterizing it) rather than the much worse
 * alternative of under-detecting real vector content and hiding it.
 */
export function classifyTextlessPage(opList: { fnArray: number[]; argsArray: unknown[] }, pageAreaUnits: number): TextlessPageKind {
  let ctm: Matrix = IDENTITY_MATRIX;
  const stack: Matrix[] = [];
  let maxImageCoverage = 0;
  let hasOtherPaint = false;

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? IDENTITY_MATRIX;
    } else if (fn === OPS.transform) {
      const args = opList.argsArray[i] as Matrix;
      ctm = composeMatrix(args, ctm);
    } else if (IMAGE_PAINT_OPS.has(fn)) {
      if (pageAreaUnits > 0) {
        const coverage = unitSquareArea(ctm) / pageAreaUnits;
        if (coverage > maxImageCoverage) maxImageCoverage = coverage;
      }
    } else if (fn === OPS.constructPath || OTHER_PAINT_OPS.has(fn)) {
      hasOtherPaint = true;
    }
  }

  if (maxImageCoverage > IMAGE_COVERAGE_THRESHOLD) return 'image';
  if (hasOtherPaint || maxImageCoverage > 0) return 'other';
  return 'none';
}

/**
 * Builds the raster-page placeholder markup directly, outside of and after
 * any DOMPurify pass - not through it. DOMPurify's ALLOWED_ATTR has no `id`
 * (and ALLOW_DATA_ATTR is false), so routing this through the sanitizer
 * would strip the one attribute the lazy-loader needs to find this element
 * later. That's safe here specifically because every value below is a
 * finite number this app itself computed (a loop counter; page.getViewport
 * dimensions), validated and rounded before being concatenated - never a
 * string that passed through anywhere an attacker-controlled PDF could
 * inject markup, quotes, or attributes.
 *
 * Sized from page.getViewport({scale:1}), not the raw MediaBox: the
 * viewport already accounts for the page's /Rotate entry and any CropBox,
 * so a rotated or cropped page still gets the correct on-screen aspect
 * ratio. The aspect-ratio box this renders reserves the final height up
 * front, before any image data exists, so nothing shifts later when the
 * lazy loader fills in the real <img src>.
 */
export function buildPagePlaceholder(pageNumber: number, widthUnits: number, heightUnits: number): string {
  const safePage = Number.isFinite(pageNumber) && pageNumber > 0 ? Math.round(pageNumber) : 0;
  const safeWidth = Number.isFinite(widthUnits) && widthUnits > 0 ? widthUnits : 1;
  const safeHeight = Number.isFinite(heightUnits) && heightUnits > 0 ? heightUnits : 1;
  const ratio = `${safeWidth.toFixed(2)}/${safeHeight.toFixed(2)}`;
  return `<figure class="pdf-page" id="pdf-page-${safePage}" style="aspect-ratio:${ratio}"><img class="pdf-page-img" alt="" draggable="false"/></figure>`;
}

export async function classifyAndRenderPage(page: PDFPageProxy, pageNumber: number): Promise<{ html: string; pageKind: PageKind }> {
  const textContent = await page.getTextContent();
  const items: PositionedTextItem[] = textContent.items.map((raw) => {
    const item = raw as { str: string; transform: number[]; height: number; hasEOL?: boolean };
    return {
      str: item.str,
      x: item.transform[4],
      y: item.transform[5],
      height: item.height,
      hasEOL: item.hasEOL ?? false,
    };
  });

  const nonWhitespaceChars = items.reduce((n, item) => n + item.str.replace(/\s+/g, '').length, 0);

  if (nonWhitespaceChars < TEXTLESS_CHAR_THRESHOLD) {
    const opList = await page.getOperatorList();
    const viewport = page.getViewport({ scale: 1 });
    const kind = classifyTextlessPage(opList, viewport.width * viewport.height);
    if (kind !== 'none') {
      return { html: buildPagePlaceholder(pageNumber, viewport.width, viewport.height), pageKind: 'raster' };
    }
  }

  const rawHtml = reconstructPage(items);
  const html = rawHtml ? sanitizePlainFragment(rawHtml) : '';
  return { html, pageKind: html ? 'text' : 'blank' };
}

async function* streamChaptersImpl(doc: PDFDocumentProxy, fallbackTitle: string): AsyncGenerator<ParseEvent> {
  let title = fallbackTitle;
  try {
    const metadata = await doc.getMetadata();
    const infoTitle = (metadata.info as { Title?: string } | undefined)?.Title;
    if (infoTitle && infoTitle.trim()) {
      title = infoTitle.trim();
    }
  } catch {
    // Metadata is optional - fall back to the file name silently.
  }
  yield { type: 'title', title };

  if (doc.numPages === 0) {
    throw new Error('This PDF has no pages');
  }
  // doc.numPages is known the moment the document loads, before any page is
  // actually extracted - same reasoning as streamEpub's 'total' event.
  yield { type: 'total', count: doc.numPages };

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    let html: string;
    let pageKind: PageKind = 'text';
    let page: PDFPageProxy | null = null;
    try {
      page = await doc.getPage(pageNumber);
      const result = await classifyAndRenderPage(page, pageNumber);
      html = result.html;
      pageKind = result.pageKind;
    } catch (err) {
      console.error('[pdf] failed to parse page', pageNumber, err);
      html = '<p class="chapter-error">[This page could not be loaded]</p>';
      pageKind = 'text';
    } finally {
      // Releases pdf.js's own per-page caches (operator list, parsed fonts
      // for this page, etc.) now that this page's text/classification pass
      // is done with them - independent of, and ahead of, any later
      // on-demand rasterization of a raster-classified page, which re-fetches
      // the page proxy itself and calls cleanup() again after rendering.
      page?.cleanup();
    }
    yield { type: 'chapter', html, pageKind };
  }
}

// ---------------------------------------------------------------------------
// On-demand page rasterization.
//
// Resolution cap: min(640, viewport width in CSS px) × min(devicePixelRatio,
// 2), hard-capped at 1600px wide - generous for a phone screen at 2x density
// while bounding a desktop-width Chromium window. At the common case (a
// phone-width viewport, dpr 2) that's a 1280px-wide raster.
//
// MAX_PIXELS additionally caps the total width×height product - a width cap
// alone doesn't bound memory for an unusually tall/narrow page, where height
// could otherwise grow far past what the width cap implies. The value
// matters: an ordinary A4-ish portrait page (height/width ~= 1.41) at the
// 1280px width cap is already ~1280x1810 = ~2.32M px, so the budget has to
// sit comfortably above that or it would shrink every normal portrait page
// below its intended width-cap resolution, defeating the point of that cap.
// 2.6 megapixels clears ordinary portraits (up to height/width ~= 2.0 at the
// 1280px cap) without shrinking them, while still giving genuinely unusual
// aspect ratios (e.g. a 1:10 banner-shaped scan) a real ceiling - caps a
// single decoded RGBA bitmap at ~10.4MB (width x height x 4 bytes/px). See
// the Milestone 2 verification report for measured per-page JPEG size and
// Chromium heap usage against this cap.
// ---------------------------------------------------------------------------

const BASE_WIDTH_CAP_PX = 640;
const MAX_DEVICE_PIXEL_RATIO = 2;
const ABSOLUTE_WIDTH_CAP_PX = 1600;
const MAX_PIXELS = 2_600_000;
const JPEG_QUALITY = 0.75;

export function computeRasterTargetSize(
  nativeWidthUnits: number,
  nativeHeightUnits: number,
  viewportWidthPx: number,
  devicePixelRatio: number,
): { width: number; height: number; scale: number } {
  const dpr = Math.max(1, Math.min(devicePixelRatio, MAX_DEVICE_PIXEL_RATIO));
  let targetWidth = Math.min(Math.min(BASE_WIDTH_CAP_PX, Math.max(1, viewportWidthPx)) * dpr, ABSOLUTE_WIDTH_CAP_PX);
  const aspect = nativeHeightUnits / Math.max(1, nativeWidthUnits);
  let targetHeight = targetWidth * aspect;

  let roundDown = false;
  if (targetWidth * targetHeight > MAX_PIXELS) {
    const shrink = Math.sqrt(MAX_PIXELS / (targetWidth * targetHeight));
    targetWidth *= shrink;
    targetHeight *= shrink;
    // Rounding each dimension independently can push their product back
    // over MAX_PIXELS by a few pixels (two numbers rounded up at once) -
    // floor instead of round once the cap has actually engaged, so the
    // post-rounding product never exceeds the budget it was computed to.
    roundDown = true;
  }

  const width = Math.max(1, roundDown ? Math.floor(targetWidth) : Math.round(targetWidth));
  const height = Math.max(1, roundDown ? Math.floor(targetHeight) : Math.round(targetHeight));
  return { width, height, scale: width / Math.max(1, nativeWidthUnits) };
}

function estimateDataUrlByteLength(dataUrl: string): number {
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx === -1 ? dataUrl : dataUrl.slice(commaIdx + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export interface PdfPageImageResult {
  dataUrl: string;
  byteLength: number;
  width: number;
  height: number;
}

export interface PendingPdfRender {
  promise: Promise<PdfPageImageResult | null>;
  cancel: () => void;
}

function renderPageImageImpl(
  doc: PDFDocumentProxy,
  pageNumber: number,
  viewportWidthPx: number,
  devicePixelRatio: number,
): PendingPdfRender {
  let cancelled = false;
  let renderTask: { cancel: (extraDelay?: number) => void } | null = null;

  const promise = (async (): Promise<PdfPageImageResult | null> => {
    const page = await doc.getPage(pageNumber);
    try {
      if (cancelled) return null;

      const nativeViewport = page.getViewport({ scale: 1 });
      const { width, height, scale } = computeRasterTargetSize(
        nativeViewport.width,
        nativeViewport.height,
        viewportWidthPx,
        devicePixelRatio,
      );
      const renderViewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      if (cancelled) return null;
      const task = page.render({ canvas, viewport: renderViewport });
      renderTask = task;
      try {
        await task.promise;
      } catch (err) {
        if (cancelled) return null;
        throw err;
      }
      if (cancelled) return null;

      const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      return { dataUrl, byteLength: estimateDataUrlByteLength(dataUrl), width: canvas.width, height: canvas.height };
    } finally {
      page.cleanup();
    }
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      renderTask?.cancel();
    },
  };
}

export interface PdfHandle {
  streamChapters(): AsyncGenerator<ParseEvent>;
  /**
   * Rasterizes one page on demand. viewportWidthPx/devicePixelRatio are
   * passed in (rather than read from `window` here) purely for
   * testability; production callers pass the real live values at the
   * moment of each call, so the resolution cap reflects the actual device,
   * not whatever it was when the PDF was first opened.
   */
  renderPageImage(pageNumber: number, viewportWidthPx: number, devicePixelRatio: number): PendingPdfRender;
  /** Releases the underlying PDFDocumentProxy. Call once, on unmount. */
  destroy(): void;
}

/**
 * Opens a PDF and returns a handle that can both stream its pages as text/
 * placeholder HTML and, later, rasterize any page on demand - the
 * PDFDocumentProxy this opens is kept alive in the closure below for that
 * later on-demand use, not just for the duration of the initial streaming
 * pass, until destroy() is called (by the reader screen, on unmount).
 */
export async function openPdf(base64: string, fallbackTitle: string): Promise<PdfHandle> {
  let doc: PDFDocumentProxy;
  try {
    doc = await pdfjsLib.getDocument({ data: base64ToBytes(base64) }).promise;
  } catch (err) {
    // No onPassword callback is passed above - there's no password-entry UI
    // yet - so pdf.js rejects immediately for any encrypted PDF with a
    // PasswordException (identified by .name, since importing the class
    // itself just to instanceof-check it isn't worth the extra coupling).
    // Without this, the raw rejection (whatever pdf.js's own message
    // happens to be for this pdf.js/engine combination) would reach the
    // user verbatim via ReaderScreen's generic catch-all.
    if (err instanceof Error && err.name === 'PasswordException') {
      throw new Error("This PDF is password-protected and can't be opened");
    }
    throw err;
  }

  let destroyed = false;

  return {
    streamChapters() {
      return streamChaptersImpl(doc, fallbackTitle);
    },
    renderPageImage(pageNumber, viewportWidthPx, devicePixelRatio) {
      return renderPageImageImpl(doc, pageNumber, viewportWidthPx, devicePixelRatio);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      // PDFDocumentProxy itself has no destroy() - releasing the document
      // (worker thread, transport, cached pages) goes through its
      // loadingTask, per pdf.js's own API. Fire-and-forget: callers (the
      // reader screen's unmount cleanup) don't need to await this.
      doc.loadingTask.destroy().catch((err) => console.error('[pdf] destroy failed', err));
    },
  };
}
