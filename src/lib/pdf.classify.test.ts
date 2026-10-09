import { describe, expect, it } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import { sanitizePlainFragment } from './epub';
import {
  buildPagePlaceholder,
  classifyAndRenderPage,
  classifyTextlessPage,
  computeRasterTargetSize,
} from './pdf';

// NOTE on real pdf.js parsing vs. this file: exercising real getDocument()
// end-to-end under vitest hangs - the specific 'pdfjs-dist' build Vite
// resolves to under Node's fake-worker fallback calls Promise.try, which
// doesn't exist in every Node version that can run this suite (the same
// category of gap as the already-documented Math.sumPrecise finding from
// the Phase C security audit; real Chromium has both, so production is
// unaffected). pdf.password.test.ts dodges this by mocking getDocument
// entirely; this file instead tests the real classification/rendering
// DECISION logic directly against hand-built operator lists and a minimal
// fake PDFPageProxy stub - the same functions pdf.ts's streaming loop
// actually calls, just invoked without a real PDFDocumentProxy in the way.
// The real, end-to-end fixtures (an actual footer-only PDF, a rotated+
// cropped one, etc.) are exercised for real in the Milestone 2 Chromium
// verification pass - real Chromium ships Promise.try, so this limitation
// doesn't apply there; that run is authoritative for "does this work on an
// actual PDF", exactly as epub.sanitize.test.ts's own header comment
// frames its Chromium run as authoritative over its own regression net.

// fnArray/argsArray shapes below were captured directly from real pdf.js
// output (via a throwaway Node script using pdf.js's own legacy build,
// which doesn't hit the Promise.try gap) against pdf-lib-generated PDFs,
// not guessed - see pdf.ts's classifyTextlessPage doc comment for why
// OPS.constructPath (not a standalone OPS.fill/stroke) is what a filled
// rectangle actually produces, and why an image's CTM comes from preceding
// OPS.transform ops rather than the paint op's own arguments.
const OPS_SAVE = 10;
const OPS_RESTORE = 11;
const OPS_TRANSFORM = 12;
const OPS_CONSTRUCT_PATH = 91;
const OPS_PAINT_IMAGE = 85;

describe('classifyTextlessPage (textless-page image/vector/blank classification)', () => {
  it('a full-page image (CTM scales the unit square to the whole page) classifies as "image"', () => {
    const opList = {
      fnArray: [OPS_SAVE, OPS_TRANSFORM, OPS_PAINT_IMAGE, OPS_RESTORE],
      argsArray: [null, [300, 0, 0, 400, 0, 0], ['img0'], null],
    };
    expect(classifyTextlessPage(opList, 300 * 400)).toBe('image');
  });

  it('a small image (well under 55% coverage) classifies as "other", not "image"', () => {
    const opList = {
      fnArray: [OPS_SAVE, OPS_TRANSFORM, OPS_PAINT_IMAGE, OPS_RESTORE],
      argsArray: [null, [60, 0, 0, 60, 10, 10], ['img0'], null], // 3600/120000 = 3%
    };
    expect(classifyTextlessPage(opList, 300 * 400)).toBe('other');
  });

  it('a filled rectangle with no image (OPS.constructPath, per real pdf.js output) classifies as "other"', () => {
    const opList = {
      fnArray: [OPS_SAVE, OPS_CONSTRUCT_PATH, OPS_RESTORE],
      argsArray: [null, [22 /* OPS.fill */, [], [0, 0, 300, 400]], null],
    };
    expect(classifyTextlessPage(opList, 300 * 400)).toBe('other');
  });

  it('no paint ops at all classifies as "none" (genuinely nothing drawn)', () => {
    const opList = { fnArray: [OPS_SAVE, OPS_RESTORE], argsArray: [null, null] };
    expect(classifyTextlessPage(opList, 300 * 400)).toBe('none');
  });

  it('an empty operator list classifies as "none"', () => {
    expect(classifyTextlessPage({ fnArray: [], argsArray: [] }, 300 * 400)).toBe('none');
  });

  it('coverage is computed relative to the CTM in effect at the paint op, honoring save/restore nesting', () => {
    // Outer save establishes a half-page scale; inner save+transform+image
    // draws at a SMALLER nested scale, then restore pops back to the outer
    // (never-used-for-painting) scale, proving the stack - not just the
    // latest transform - determines the CTM at each paint op.
    const opList = {
      fnArray: [
        OPS_SAVE,
        OPS_TRANSFORM, // outer: scale to 300x400 (full page) - never painted into directly
        OPS_SAVE,
        OPS_TRANSFORM, // inner: an additional 0.1x0.1 scale on top -> effectively 30x40
        OPS_PAINT_IMAGE,
        OPS_RESTORE, // back to the outer 300x400 scope
        OPS_RESTORE,
      ],
      argsArray: [null, [300, 0, 0, 400, 0, 0], null, [0.1, 0, 0, 0.1, 0, 0], ['img0'], null, null],
    };
    // 30*40 / (300*400) = 1200/120000 = 1% - well under the image threshold,
    // and the only paint op is the image, so this must be 'other' (coverage
    // > 0 but not qualifying), not 'image'.
    expect(classifyTextlessPage(opList, 300 * 400)).toBe('other');
  });

  it('coverage over the exact 55% threshold is still "other", not "image" (strictly greater-than, not >=)', () => {
    const opList = {
      fnArray: [OPS_TRANSFORM, OPS_PAINT_IMAGE],
      argsArray: [[300, 0, 0, 220, 0, 0], ['img0']], // 300*220/120000 = 0.55 exactly
    };
    expect(classifyTextlessPage(opList, 300 * 400)).toBe('other');
  });

  it('zero page area never divides by zero or throws', () => {
    const opList = { fnArray: [OPS_TRANSFORM, OPS_PAINT_IMAGE], argsArray: [[1, 0, 0, 1, 0, 0], ['img0']] };
    expect(() => classifyTextlessPage(opList, 0)).not.toThrow();
  });
});

describe('buildPagePlaceholder (validated-integers-only markup, outside DOMPurify)', () => {
  it('builds a figure with id="pdf-page-N" and an aspect-ratio matching width/height', () => {
    const html = buildPagePlaceholder(42, 595, 842);
    expect(html).toBe(
      '<figure class="pdf-page" id="pdf-page-42" style="aspect-ratio:595.00/842.00"><img class="pdf-page-img" alt="" draggable="false"/></figure>',
    );
  });

  it('rounds a non-integer page number rather than embedding a fractional id', () => {
    const html = buildPagePlaceholder(3.9, 100, 100);
    expect(html).toContain('id="pdf-page-4"');
  });

  it('falls back to a safe placeholder size for a non-finite or non-positive dimension, never NaN/Infinity in the markup', () => {
    const html1 = buildPagePlaceholder(1, NaN, 100);
    expect(html1).not.toContain('NaN');
    const html2 = buildPagePlaceholder(1, 100, -5);
    expect(html2).not.toContain('-5');
    const html3 = buildPagePlaceholder(1, Infinity, 100);
    expect(html3).not.toContain('Infinity');
  });

  it('falls back to page 0 for a non-finite or non-positive page number, never embedding NaN/Infinity/negative in the id', () => {
    expect(buildPagePlaceholder(NaN, 100, 100)).toContain('id="pdf-page-0"');
    expect(buildPagePlaceholder(-1, 100, 100)).toContain('id="pdf-page-0"');
    expect(buildPagePlaceholder(Infinity, 100, 100)).toContain('id="pdf-page-0"');
  });

  it('contains no attributes beyond class/id/style on the figure and class/alt/draggable on the img - no id/data-* smuggled onto the img, nothing beyond this fixed shape', () => {
    const html = buildPagePlaceholder(1, 100, 200);
    expect(html).toMatch(
      /^<figure class="pdf-page" id="pdf-page-1" style="aspect-ratio:[\d.]+\/[\d.]+"><img class="pdf-page-img" alt="" draggable="false"\/><\/figure>$/,
    );
  });
});

// Minimal fake satisfying only the 3 PDFPageProxy methods
// classifyAndRenderPage actually calls - avoids needing a real pdf.js
// document (see the file-level note on the Promise.try/Node gap above).
function fakePage(opts: {
  items: Array<{ str: string; transform?: number[]; height?: number; hasEOL?: boolean }>;
  opList?: { fnArray: number[]; argsArray: unknown[] };
  viewport?: { width: number; height: number };
}): PDFPageProxy {
  return {
    getTextContent: async () => ({
      items: opts.items.map((it) => ({
        str: it.str,
        transform: it.transform ?? [1, 0, 0, 1, 0, 0],
        height: it.height ?? 10,
        hasEOL: it.hasEOL ?? false,
      })),
    }),
    getOperatorList: async () => opts.opList ?? { fnArray: [], argsArray: [] },
    getViewport: () => opts.viewport ?? { width: 300, height: 400 },
  } as unknown as PDFPageProxy;
}

describe('classifyAndRenderPage (the real per-page decision pdf.ts streams)', () => {
  it('a footer-only page (full-page image + short "Page 47" text) goes to the raster path, discarding the footer text', async () => {
    const page = fakePage({
      items: [{ str: 'Page 47', transform: [1, 0, 0, 1, 20, 20] }],
      opList: { fnArray: [OPS_TRANSFORM, OPS_PAINT_IMAGE], argsArray: [[300, 0, 0, 400, 0, 0], ['img0']] },
      viewport: { width: 300, height: 400 },
    });
    const result = await classifyAndRenderPage(page, 47);
    expect(result.pageKind).toBe('raster');
    expect(result.html).toContain('id="pdf-page-47"');
    expect(result.html).not.toContain('Page 47');
  });

  it('a lone "Page 47" with no image/vector content stays on the text path', async () => {
    const page = fakePage({ items: [{ str: 'Page 47', transform: [1, 0, 0, 1, 20, 20] }] });
    const result = await classifyAndRenderPage(page, 47);
    expect(result.pageKind).toBe('text');
    expect(result.html).toContain('Page 47');
    expect(result.html).not.toContain('class="pdf-page"');
  });

  it('an OCR-style page (>=20 real chars PLUS a full-page image) stays on the text path exactly as today - never calls getOperatorList at all', async () => {
    let operatorListCalled = false;
    const page = {
      getTextContent: async () => ({
        items: [{ str: 'This page has a real paragraph of OCR text on it.', transform: [1, 0, 0, 1, 20, 350], height: 10, hasEOL: false }],
      }),
      getOperatorList: async () => {
        operatorListCalled = true;
        return { fnArray: [OPS_TRANSFORM, OPS_PAINT_IMAGE], argsArray: [[300, 0, 0, 400, 0, 0], ['img0']] };
      },
      getViewport: () => ({ width: 300, height: 400 }),
    } as unknown as PDFPageProxy;

    const result = await classifyAndRenderPage(page, 1);
    expect(result.pageKind).toBe('text');
    expect(result.html).toContain('OCR text');
    // Point 1's cost requirement: a page at/above the char threshold must
    // never pay for getOperatorList at all.
    expect(operatorListCalled).toBe(false);
  });

  it('a genuinely blank page (no text, no paint ops) emits nothing at all', async () => {
    const page = fakePage({ items: [], opList: { fnArray: [], argsArray: [] } });
    const result = await classifyAndRenderPage(page, 1);
    expect(result.pageKind).toBe('blank');
    expect(result.html).toBe('');
  });

  it('vector art with no qualifying image rasterizes too', async () => {
    const page = fakePage({
      items: [],
      opList: { fnArray: [OPS_CONSTRUCT_PATH], argsArray: [[22, [], [0, 0, 300, 400]]] },
    });
    const result = await classifyAndRenderPage(page, 1);
    expect(result.pageKind).toBe('raster');
  });

  it('sizes the placeholder from getViewport({scale:1}), not any other source', async () => {
    const page = fakePage({
      items: [],
      opList: { fnArray: [OPS_CONSTRUCT_PATH], argsArray: [[22, [], [0, 0, 1, 1]]] },
      // Deliberately a viewport that does NOT match the fnArray's own
      // bbox/page-area numbers above, so a correct implementation can only
      // reflect it by actually calling getViewport - not by coincidence.
      viewport: { width: 111, height: 222 },
    });
    const result = await classifyAndRenderPage(page, 9);
    expect(result.html).toContain('aspect-ratio:111.00/222.00');
  });
});

describe('text output routed through DOMPurify (hardening, no behavior change for legitimate text)', () => {
  it('escaped entities survive the sanitize pass unchanged', () => {
    const html = sanitizePlainFragment('<p>5 &lt; 10 &amp; 10 &gt; 5, allegedly</p>');
    expect(html).toContain('5 &lt; 10 &amp; 10 &gt; 5, allegedly');
    expect(html).not.toContain('5 < 10');
  });

  it('a plain reconstructed-text paragraph round-trips exactly', () => {
    const html = sanitizePlainFragment('<p>Just a normal paragraph of real body text here.</p>');
    expect(html).toBe('<p>Just a normal paragraph of real body text here.</p>');
  });

  it('a heading survives as <h2>', () => {
    const html = sanitizePlainFragment('<h2>Chapter Title</h2>');
    expect(html).toBe('<h2>Chapter Title</h2>');
  });

  it('still strips anything outside the allowlist, even though pdf.ts never emits it today - defense in depth, not a behavior change', () => {
    const html = sanitizePlainFragment('<p>safe<script>window.__pwn(1)</script></p>');
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).toContain('safe');
  });
});

describe('computeRasterTargetSize (resolution + pixel cap math)', () => {
  it('caps width at min(640, viewportWidthPx) * min(dpr, 2)', () => {
    const { width } = computeRasterTargetSize(1000, 1000, 320, 2);
    expect(width).toBe(640); // min(640,320)*2 = 640
  });

  it('caps devicePixelRatio at 2 even when the device reports higher', () => {
    const { width } = computeRasterTargetSize(1000, 1000, 320, 3.5);
    expect(width).toBe(640); // same as dpr=2, not 320*3.5=1120
  });

  it('never exceeds the 1600px absolute width cap, even on a very wide viewport', () => {
    const { width } = computeRasterTargetSize(1000, 1000, 2000, 2);
    expect(width).toBeLessThanOrEqual(1600);
  });

  it('additionally caps total pixel count for an unusually tall/narrow page, beyond what the width cap alone would allow', () => {
    // Extremely tall page (1:20 aspect) - width cap alone would still let
    // height balloon to width*20, far past any reasonable memory budget.
    const { width, height } = computeRasterTargetSize(100, 2000, 640, 2);
    expect(width * height).toBeLessThanOrEqual(2_600_000);
    // Confirms the pixel cap actually engaged (shrunk below the width cap
    // that a 640-viewport/2x-dpr page would otherwise get: 1280px).
    expect(width).toBeLessThan(1280);
  });

  it('keeps the page aspect ratio when the pixel cap shrinks both dimensions', () => {
    const { width, height } = computeRasterTargetSize(100, 2000, 640, 2);
    expect(height / width).toBeCloseTo(2000 / 100, 1);
  });

  it('an ordinary A4-ish portrait page is NOT shrunk below its width-cap resolution by the pixel cap', () => {
    const { width, height } = computeRasterTargetSize(595, 842, 640, 2); // A4-ish, height/width ~= 1.41
    expect(width).toBe(1280); // the width cap (640 viewport * 2 dpr), untouched by the pixel cap
    expect(width * height).toBeLessThanOrEqual(2_600_000);
  });

  it('a narrower viewport (phone CSS width) produces a proportionally smaller raster', () => {
    const { width } = computeRasterTargetSize(595, 842, 375, 2);
    expect(width).toBe(750); // min(640,375)*2
  });
});
