import * as pdfjsLib from 'pdfjs-dist';
// `?url` is Vite's explicit static-asset import: it copies this file into
// the build output with a content hash and hands back that URL as a plain
// string, instead of trying to execute it as a module. This is what keeps
// the pdf.js worker fully local - verified against a real production build
// (no dev-server-only behavior) that this pulls in zero CDN/network
// references; pdf.js examples commonly load this worker from unpkg/cdnjs,
// which would silently violate this app's offline requirement.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type ParseEvent = { type: 'title'; title: string } | { type: 'chapter'; html: string };

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
 * This is a heuristic, not a guarantee. It was validated against a
 * representative single-column test case (matching the project's target of
 * clean extraction on light-novel-style PDFs) and reconstructed it
 * perfectly, but real-world PDFs vary: multi-run lines from font/style
 * changes mid-line, hyphenated wraps, footnotes, and repeated headers or
 * page numbers on every page aren't specifically handled and may need
 * follow-up once tested against real library files.
 */
function reconstructPage(items: PositionedTextItem[]): string {
  const clean = items.filter((item) => item.str.trim().length > 0);
  if (clean.length === 0) {
    return '<p class="pdf-page-gap">[Image page — not shown]</p>';
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

/**
 * Streams a PDF's title and pages as they're extracted, instead of fully
 * extracting every page before returning anything - see streamEpub for why.
 * pdf.js's own per-page getTextContent() calls were already incremental
 * internally; the change here is emitting each page's reconstructed HTML
 * the moment it's ready rather than collecting all of them first.
 */
export async function* streamPdf(base64: string, fallbackTitle: string): AsyncGenerator<ParseEvent> {
  const doc = await pdfjsLib.getDocument({ data: base64ToBytes(base64) }).promise;

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

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    let html: string;
    try {
      const page = await doc.getPage(pageNumber);
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
      html = reconstructPage(items);
    } catch (err) {
      console.error('[pdf] failed to parse page', pageNumber, err);
      html = '<p class="chapter-error">[This page could not be loaded]</p>';
    }
    yield { type: 'chapter', html };
  }
}
