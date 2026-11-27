import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import type { LibraryFile } from '../lib/libraryFolder';
import { FileTooLargeError, createFileSource } from '../lib/fileBridge';
import { DocxError } from '../lib/docxError';
import { cleanTitle } from '../lib/libraryText';
import type { EpubBook } from '../lib/epub';
import { ChapterList } from '../components/ChapterList';
import ImageLightbox, { type LightboxImage } from '../components/ImageLightbox';
import TocDrawer from '../components/TocDrawer';
import { ImageContext } from '../components/imageContext';
import { ImageController } from '../lib/imageController';
import type { FullImage } from '../lib/imageProcessor';
import { TableAdaptContext } from '../components/tableAdaptContext';
import { TableAdaptController, cloneForGrid, watchWidth } from '../lib/tableAdapter';
import { anchorScrollTarget, needsScroll, preserveAnchorDuring, settingsAffectLayout } from '../lib/reanchor';
import {
  canScrollWithinWindow,
  prependCompensation,
  restoreWindowStart,
  toAbsoluteAnchor,
  toDomAnchor,
} from '../lib/chapterWindow';
import { planWindow } from '../lib/mountWindow';
import type { PageKind, ParseEvent, PdfHandle } from '../lib/pdf';
import { pageKindOfHtml, pdfAsBook, type PdfBook } from '../lib/pdfBook';
import { PageCancelledError } from '../lib/pdfPages';
import { PdfPageLoader } from '../lib/pdfPageLoader';
import { PdfPageLoaderContext } from '../components/pdfPageLoaderContext';
import { pushKind, shouldShowScannedNotice } from '../lib/scannedNotice';
import {
  computeAnchor,
  computeProgressFraction,
  findBlockAtY,
  flattenToLeafBlocks,
  resolveAnchorToDocumentY,
  type Anchor,
} from '../lib/readerAnchor';
import { ANCHOR_VERSION, anchorForRestore, loadPosition, markOpened, savePosition, type StoredPosition } from '../lib/readingPosition';
import { ANCHOR_ATTR, LINK_ATTR, flattenToc, weightedProgress, type TocItem } from '../lib/toc';
import {
  DEFAULT_READER_SETTINGS,
  isDarkTheme,
  FONT_FAMILY_OPTIONS,
  FONT_FAMILY_STACKS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  THEME_COLORS,
  getReaderSettings,
  saveReaderSettings,
  type ReaderSettings,
  type ThemeName,
} from '../lib/readerSettings';
import { useSystemTheme } from '../lib/systemTheme';

interface ReaderScreenProps {
  file: LibraryFile;
  onBack: () => void;
  /**
   * The app's single hardware-back handler calls whatever is in here first.
   * The reader puts "close the expanded table" in it while one is open, so
   * Back closes the overlay instead of leaving the book.
   */
  overlayCloseRef?: RefObject<(() => void) | null>;
}

// epub.ts and pdf.ts intentionally produce this identical shape - a title
// plus an ordered list of already-sanitized chapter HTML strings - so
// everything below (rendering, fonts, themes, auto-hide nav) is written
// once and works for both formats without a fork. isComplete is false
// while chapters are still streaming in behind the ones already shown.
//
// chaptersHtml is a window of the book, not necessarily all of it from the
// start: chaptersHtml[k] is chapter firstChapterIndex + k. For an EPUB or a
// Word document it is the chapters MOUNTED in the page right now, and no
// more: chapters are loaded ahead of and behind the reader as they scroll, and
// unmounted again once they are far enough away (mountWindow.ts says why the
// page must not be allowed to grow with the book, and how the window is
// chosen). isComplete then means "the window reaches the last chapter". A PDF
// is different: its text pass streams every page and all of them stay
// mounted.
interface ParsedBook {
  title: string;
  firstChapterIndex: number;
  chaptersHtml: string[];
  isComplete: boolean;
}

// The first few chapters are taken together so the reader opens on a fuller
// screen instead of a single short chapter; everything after that is brought
// in one chapter at a time, as the reader nears it (maintainWindow). When
// restoring a saved position they are the saved chapter's neighbourhood.
const INITIAL_CHAPTER_BATCH = 4;

// A jump to a page that is not mounted shows its "Getting to ..." bar only if
// extracting the page takes longer than this (a PDF page is normally ready in a
// frame or two, and a bar that flashes is worse than none).
const JUMP_WAIT_BAR_DELAY_MS = 400;

// Scroll position is saved this long after scrolling stops, not on every
// scroll event - cheap enough per the anchor's binary search, but no
// reason to write on every frame of a fling.
const SAVE_DEBOUNCE_MS = 500;

// The position is also remembered (not saved) this soon after scrolling stops,
// so a rotation or resize - which only announces itself after the layout has
// already moved - can restore to where the reader was just before it.
const ANCHOR_CACHE_MS = 150;

// document.fonts.ready should resolve almost immediately for this app (every
// font is bundled via @fontsource, nothing is fetched over the network), but
// is capped anyway so a restore can never hang indefinitely on it.
const FONT_WAIT_TIMEOUT_MS = 2000;

// Dynamic imports here, not static ones: pdf.js (~2.2MB worker alone) and
// jszip only need to load when a book of that actual format is opened, not
// as part of the app's initial bundle every time - the production build
// flagged the combined bundle size once pdf.js was added statically.
//
// Unlike EPUB's plain generator, a PDF needs its PDFDocumentProxy (wrapped
// in PdfHandle) kept alive past the initial streaming pass, for later
// on-demand page rasterization - so this returns the handle alongside the
// generator instead of just yielding straight through it.
//
// Bytes arrive through the chunked file bridge (fileBridge.ts): a PDF is read
// range-by-range on demand by pdf.js; an EPUB is read once, chunk by chunk,
// straight into one preallocated Uint8Array (no whole-file Base64 string).
//
// An EPUB is opened lazily (epubFile.ts): only its index is read up front, and
// stream(startIndex) parses chapters from there on - so a saved position deep
// in a long book doesn't first parse everything before it. A PDF is the same
// to the reader: its pages are chapters (pdfBook.ts), and a page's text is
// only extracted when the reader's window needs it. The PdfHandle is also kept,
// for rasterizing scanned pages and for releasing the document.
interface OpenedBook {
  pdfHandle: PdfHandle | null;
  /** Random-access chapter loading: an EPUB, a Word document, or a PDF seen as a book of pages. */
  epub: EpubBook;
  stream(startIndex: number): AsyncGenerator<ParseEvent>;
}

async function openBookStream(uri: string, fileName: string, signal: AbortSignal): Promise<OpenedBook> {
  if (fileName.toLowerCase().endsWith('.pdf')) {
    const source = await createFileSource(uri, { signal });
    const { openPdf } = await import('../lib/pdf');
    const handle = await openPdf(source, fileName);
    const pages = pdfAsBook(handle);
    return { pdfHandle: handle, epub: pages, stream: (startIndex) => pages.stream(startIndex) };
  }
  // A Word document is converted into virtual chapters and then behaves exactly like an EPUB (docx.ts). It is
  // routed here explicitly: it must never reach the EPUB parser, which would fail on it.
  if (fileName.toLowerCase().endsWith('.docx')) {
    const { openDocxFile } = await import('../lib/docxFile');
    const docx = await openDocxFile(uri, cleanTitle(fileName), { signal });
    return { pdfHandle: null, epub: docx, stream: (startIndex) => docx.stream(startIndex) };
  }
  const { openEpubFile } = await import('../lib/epubFile');
  const epub = await openEpubFile(uri, fileName, { signal });
  return { pdfHandle: null, epub, stream: (startIndex) => epub.stream(startIndex) };
}

const NAV_IDLE_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

function getChapterElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll(':scope > .chapter'));
}

/** Where, in document coordinates, a table-of-contents fragment sits inside a mounted chapter; null if the chapter or the id is not there. */
function fragmentDocumentY(container: HTMLElement | null, chapterIndex: number, firstChapterIndex: number, fragment: string | undefined): number | null {
  if (!fragment) return null;
  const chapter = getChapterElements(container)[chapterIndex - firstChapterIndex];
  if (!chapter) return null;
  for (const el of Array.from(chapter.querySelectorAll(`[${ANCHOR_ATTR}]`))) {
    if (el.getAttribute(ANCHOR_ATTR) === fragment) return el.getBoundingClientRect().top + window.scrollY;
  }
  return null;
}

export default function ReaderScreen({ file, onBack, overlayCloseRef }: ReaderScreenProps) {
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS);
  const [book, setBook] = useState<ParsedBook | null>(null);
  const [totalChapters, setTotalChapters] = useState<number | null>(null);
  const [status, setStatus] = useState('Loading...');
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [navVisible, setNavVisible] = useState(true);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Reading-position restore ---
  const [restoreTarget, setRestoreTarget] = useState<StoredPosition | null>(null);
  // Set by "Start from beginning" when the book was opened partway in: the
  // load effect runs again, ignoring the saved position, so chapter 0 is what
  // gets mounted (rather than the chapters around the saved spot).
  const [skipRestore, setSkipRestore] = useState(false);
  // True once it's safe to actually show reading content: immediately for a
  // book with no saved position, or once a saved position has been resolved
  // and scrolled to (or the user chose to skip that via "Start from
  // beginning"). The content element stays in the DOM (needed so restore can
  // measure it) but visually hidden until this flips true, so there's no
  // flash of chapter 1 before jumping to a saved spot deep in the book.
  const [contentRevealed, setContentRevealed] = useState(false);
  const restoreAbortedRef = useRef(false);
  const restoreStartedRef = useRef(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<Anchor | null>(null);
  const progressFractionRef = useRef(0);

  // --- Windowed chapters (EPUB opened at a saved position) ---
  // Latest book state for callbacks that must not close over a stale one.
  const bookRef = useRef<ParsedBook | null>(null);
  const revealedRef = useRef(false);
  const settingsRef = useRef<ReaderSettings>(DEFAULT_READER_SETTINGS);
  // --- Re-anchoring after a layout change ---
  // The anchor captured BEFORE a font/line-height/theme change, to put the
  // reader back on the same passage once the new layout has settled. Null
  // when no such change is pending.
  const reflowAnchorRef = useRef<Anchor | null>(null);
  const reflowTokenRef = useRef(0);
  // --- Tables ---
  const [tableController, setTableController] = useState<TableAdaptController | null>(null);
  const preserveViewRef = useRef<(work: () => void) => void>((work) => work());
  // --- Images and the lightbox ---
  const [imageController, setImageController] = useState<ImageController | null>(null);
  // What the full-screen overlay is showing, if anything: an Expand Grid copy of a
  // table, or a picture the reader tapped (with how to decode it at full detail).
  const [lightbox, setLightbox] = useState<
    | { kind: 'table'; node: HTMLTableElement }
    | { kind: 'image'; image: LightboxImage; loadFull: () => Promise<FullImage | null>; src: string }
    | null
  >(null);
  // --- Table of contents ---
  // Null until the book's TOC has been read (and for a book without one).
  const [toc, setToc] = useState<TocItem[] | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  // Where the reader was when the drawer was opened: which chapter, and overall progress.
  const [tocView, setTocView] = useState({ chapterIndex: 0, progress: 0 });
  // An EPUB jump to a chapter outside the mounted window reopens the window at it (the same
  // way a saved position does); `jump` is that request. A new object each time, so jumping to
  // the same chapter again still runs.
  const [jump, setJump] = useState<{ chapterIndex: number; fragment?: string } | null>(null);
  // A PDF jump to a page the text pass has not reached yet waits for it; null when not waiting.
  const [jumpWait, setJumpWait] = useState<TocItem | null>(null);
  const jumpFragmentRef = useRef<string | undefined>(undefined);
  const savePositionAfterJumpRef = useRef(false);
  // Each chapter's size, to weight reading progress; null if the book cannot say (or a PDF).
  const weightsRef = useRef<readonly number[] | null>(null);
  // Kept alive for loading chapters on demand (for a PDF: its pages).
  const epubRef = useRef<EpubBook | null>(null);
  const loadingPreviousRef = useRef(false);
  const loadingNextRef = useRef(false);
  // The chapter element that was at the top of the viewport just before
  // chapters were inserted above it or unmounted from above it, and where it
  // was - used to put it back exactly once the change has been committed (see
  // the layout effect below). `firstChapterIndex` is the window start the
  // change leads to: a note that no longer matches is stale and ignored.
  const scrollAnchorRef = useRef<{ el: HTMLElement; top: number; firstChapterIndex: number } | null>(null);
  // While the full-screen viewer is open the mounted chapters are left exactly as they are.
  const lightboxOpenRef = useRef(false);
  // While a font/theme/rotation re-anchor is under way the reader is put back on its passage by chapter index: the
  // mounted chapters must not change under it. The tick makes the window manager run once it is over.
  const reflowingRef = useRef(0);
  const [windowTick, setWindowTick] = useState(0);

  // --- PDF-specific: on-demand page rasterization ---
  // null for an EPUB (or before the handle is ready); set once openBookStream
  // resolves for a PDF, kept alive until this effect's cleanup destroys it.
  const pdfHandleRef = useRef<PdfHandle | null>(null);
  const pageLoaderRef = useRef<PdfPageLoader | null>(null);
  const [pdfLoader, setPdfLoader] = useState<PdfPageLoader | null>(null);
  // A jump to a page outside the mounted window is in progress (its text is being extracted); a newer jump or Cancel ends it.
  const relocateTokenRef = useRef(0);
  const [relocating, setRelocating] = useState(false);
  const pageKindWindowRef = useRef<PageKind[]>([]);
  const scannedNoticeDismissedRef = useRef(false);
  const [scannedNoticeVisible, setScannedNoticeVisible] = useState(false);

  useEffect(() => {
    getReaderSettings().then(setSettings);
  }, []);

  // Scanned-book detection: each PDF page that is loaded says what kind of page it is (text, picture, blank); a run of picture
  // pages shows the notice that font and size will not apply to them. Only a PDF's pages carry a kind.
  function noteScanned(kind: PageKind) {
    if (scannedNoticeDismissedRef.current) return;
    pageKindWindowRef.current = pushKind(pageKindWindowRef.current, kind);
    if (shouldShowScannedNotice(pageKindWindowRef.current)) setScannedNoticeVisible(true);
  }

  useEffect(() => {
    let cancelled = false;
    let generator: AsyncGenerator<ParseEvent> | null = null;
    let imageControllerLocal: ImageController | null = null;
    // Stops in-flight chunked reads (and range requests, via the PDF handle)
    // when the user backs out mid-open, instead of reading on for nobody.
    const abortController = new AbortController();

    // Reset restore state for this specific file - a fresh mount-equivalent
    // each time `file` changes (App.tsx actually unmounts/remounts this
    // component on navigation, but belt-and-suspenders here costs nothing).
    restoreAbortedRef.current = false;
    restoreStartedRef.current = false;
    anchorRef.current = null;
    progressFractionRef.current = 0;
    epubRef.current = null;
    weightsRef.current = null;
    setToc(null);
    setTocOpen(false);
    setJumpWait(null);
    setImageController(null);
    setPdfLoader(null);
    setRelocating(false);
    relocateTokenRef.current++;
    setLightbox(null);
    loadingPreviousRef.current = false;
    loadingNextRef.current = false;
    scrollAnchorRef.current = null;
    pageKindWindowRef.current = [];
    scannedNoticeDismissedRef.current = false;
    setRestoreTarget(null);
    setContentRevealed(false);
    setTotalChapters(null);
    setScannedNoticeVisible(false);

    async function load() {
      setStatus('Opening book...');
      setError(null);
      setBook(null);
      try {
        console.log('[ReaderScreen] load: reading file', file.uri);
        markOpened(file).catch((err) => console.error('[ReaderScreen] markOpened failed', err));
        const [savedPosition, opened] = await Promise.all([
          skipRestore
            ? Promise.resolve(null)
            : jump
              ? // A jump from the table of contents: open at the start of that chapter, as a saved position would.
                Promise.resolve<StoredPosition>({
                  anchor: { chapterIndex: jump.chapterIndex, blockIndex: 0, blockFraction: 0 },
                  anchorVersion: ANCHOR_VERSION,
                  name: file.name,
                  size: file.size,
                  savedAt: Date.now(),
                })
              : loadPosition(file).catch((err) => {
                  console.error('[ReaderScreen] loadPosition failed', err);
                  return null;
                }),
          openBookStream(file.uri, file.name, abortController.signal),
        ]);
        if (cancelled) {
          opened.pdfHandle?.destroy();
          return;
        }
        if (savedPosition) {
          console.log('[ReaderScreen] load: restoring saved position', savedPosition.anchor);
          // An anchor from a layout this build doesn't understand restores to
          // the start of its chapter instead of a wrong paragraph.
          setRestoreTarget({ ...savedPosition, anchor: anchorForRestore(savedPosition) });
        } else {
          setContentRevealed(true);
        }

        console.log('[ReaderScreen] load: opened, parsing', file.name);
        setStatus('Parsing...');

        pdfHandleRef.current = opened.pdfHandle;
        epubRef.current = opened.epub;
        weightsRef.current = opened.epub?.chapterWeights ?? null;
        // The table of contents is read in the background (EPUB: only its nav/ncx file; PDF: the outline).
        (opened.epub ? opened.epub.toc() : (opened.pdfHandle?.getOutline() ?? Promise.resolve([])))
          .then((items) => {
            if (!cancelled) setToc(items);
          })
          .catch((err) => console.error('[ReaderScreen] table of contents failed', err));
        if (opened.pdfHandle) {
          // Scanned pages are rasterized as they come near the screen (not before the reader is at its place), and let go of
          // when they unmount: each mounted page registers with the loader (ChapterSection).
          const handle = opened.pdfHandle;
          const loader = new PdfPageLoader({
            renderPageImage: (pageNumber, viewportWidthPx, devicePixelRatio) => handle.renderPageImage(pageNumber, viewportWidthPx, devicePixelRatio),
          });
          loader.pause();
          pageLoaderRef.current = loader;
          setPdfLoader(loader);
        } else if (opened.epub) {
          // Pictures near the screen are downscaled in the background; this
          // book's blob: URLs are revoked when it closes (see the cleanup).
          imageControllerLocal = new ImageController(opened.epub.images);
          setImageController(imageControllerLocal);
        }
        // A book opened at a saved position starts at that chapter (plus
        // the one before it), not at chapter 0. Saved anchors are chapter-
        // relative, so they are valid as-is - nothing before the saved
        // chapter has to be parsed to resolve one.
        const startIndex = savedPosition ? restoreWindowStart(savedPosition.anchor.chapterIndex, opened.epub.chapterCount) : 0;

        // A book is not streamed through whole: only enough chapters to fill the screen and a
        // little more are taken from the stream now, and the window manager (maintainWindow) loads and unmounts the
        // rest as the reader moves, keeping the page short. Nothing before the saved chapter is parsed, nothing far
        // after it.
        const epub = opened.epub;
        setTotalChapters(epub.chapterCount);
        const target = savedPosition ? Math.min(Math.max(savedPosition.anchor.chapterIndex, 0), epub.chapterCount - 1) : startIndex;
        const wanted = Math.min(epub.chapterCount, Math.max(startIndex + INITIAL_CHAPTER_BATCH, target + 1)) - startIndex;
        const first: string[] = [];
        generator = opened.stream(startIndex);
        let bookTitle = file.name;
        for await (const event of generator) {
          if (cancelled) return;
          if (event.type === 'title') bookTitle = event.title;
          else if (event.type === 'chapter') {
            if (event.pageKind) noteScanned(event.pageKind);
            first.push(event.html);
            if (first.length >= wanted) break;
          }
        }
        await generator.return(undefined);
        generator = null;
        if (cancelled) return;
        setBook({ title: bookTitle, firstChapterIndex: startIndex, chaptersHtml: first, isComplete: startIndex + first.length >= epub.chapterCount });
        setStatus('');
        return;
      } catch (err) {
        if (cancelled) return;
        console.error('[ReaderScreen] load: failed', err);
        // FileTooLargeError's message is already a complete, user-facing
        // sentence; String(err) would prefix it with the class name.
        setError(err instanceof FileTooLargeError || err instanceof DocxError ? err.message : String(err));
        setStatus('Failed to open book.');
      }
    }

    load();
    return () => {
      cancelled = true;
      imageControllerLocal?.destroy();
      // The book is closing: every blob: URL it made is revoked.
      epubRef.current?.close();
      epubRef.current = null;
      abortController.abort();
      // Signals the generator to stop at its next suspension point instead
      // of continuing to parse chapters nobody will ever see, e.g. when the
      // user backs out of a book mid-load.
      generator?.return(undefined);
      // PDF lifecycle: the lazy-page loader owns cancelling any in-flight
      // RenderTask; the PDFDocumentProxy itself (kept alive specifically
      // for on-demand rasterization - see openBookStream) is only released
      // here, on this effect's cleanup (unmount, or `file` changing to a
      // different book).
      pageLoaderRef.current?.destroy();
      pageLoaderRef.current = null;
      pdfHandleRef.current?.destroy();
      pdfHandleRef.current = null;
      // Unmount flush: uses whatever anchor was last computed/cached rather
      // than re-measuring, since by the time this runs the DOM this effect
      // owns may already be gone.
      if (anchorRef.current) {
        savePosition(file, anchorRef.current, progressFractionRef.current).catch((err) =>
          console.error('[ReaderScreen] unmount flush failed', err),
        );
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, skipRestore, jump]);

  // --- PDF-specific: scanned pages are rasterized while they are near the screen ---
  // Each mounted page registers its placeholder with the loader (ChapterSection) and lets go of it when it unmounts. Rendering
  // waits until the reader is at its place: the pages at the top of the page are not the ones that will be read.
  useEffect(() => {
    if (!pdfLoader) return;
    if (contentRevealed) pdfLoader.resume();
    else pdfLoader.pause();
  }, [pdfLoader, contentRevealed]);

  function dismissScannedNotice() {
    scannedNoticeDismissedRef.current = true;
    setScannedNoticeVisible(false);
  }

  // --- Resolving the restore target once it's available ---
  useEffect(() => {
    if (!restoreTarget || contentRevealed || restoreStartedRef.current || error) return;
    const targetChapterIndex = restoreTarget.anchor.chapterIndex;
    const firstChapterIndex = book?.firstChapterIndex ?? 0;
    // Chapters 0..parsedSoFar-1 of the book are loaded or (when opened at a
    // saved position) deliberately skipped - what matters is whether the
    // target chapter has arrived, in book terms, not DOM terms.
    const parsedSoFar = firstChapterIndex + (book?.chaptersHtml.length ?? 0);
    const streamDone = book?.isComplete ?? false;
    // Either the target chapter has actually arrived, or the stream
    // finished without ever reaching it (a stale/corrupted chapterIndex
    // past the real total) - resolveAnchorToDocumentY clamps to the
    // nearest valid chapter/block in that second case.
    if (parsedSoFar <= targetChapterIndex && !streamDone) return;

    restoreStartedRef.current = true;
    (async () => {
      if (restoreAbortedRef.current) return;
      await scrollToAnchor(restoreTarget.anchor);
      if (restoreAbortedRef.current) return;
      setContentRevealed(true);
    })();

    async function scrollToAnchor(anchor: Anchor): Promise<void> {
      // Fonts load async; resolving/scrolling before the active font has
      // settled would measure fallback-font metrics and land in the wrong
      // spot the moment the real font swaps in. document.fonts.ready covers
      // every font @fontsource registered; the explicit load() below is a
      // belt-and-suspenders check for the specific family/size actually in
      // use, per the same concern.
      await withTimeout(document.fonts.ready, FONT_WAIT_TIMEOUT_MS);
      if (restoreAbortedRef.current) return;
      try {
        await withTimeout(document.fonts.load(`${settings.fontSize}px ${FONT_FAMILY_STACKS[settings.fontFamily]}`), FONT_WAIT_TIMEOUT_MS);
      } catch {
        // Best effort - fonts.ready already covers the common case.
      }
      if (restoreAbortedRef.current) return;

      // The saved anchor is book-relative; the DOM holds a window of the
      // book, so translate (and clamp) it to the mounted chapters first.
      const chapters = getChapterElements(contentRef.current);
      const fragmentY = () => fragmentDocumentY(contentRef.current, anchor.chapterIndex, firstChapterIndex, jumpFragmentRef.current);
      const firstY = fragmentY() ?? resolveAnchorToDocumentY(chapters, toDomAnchor(anchor, firstChapterIndex, chapters.length), window.scrollY);
      if (firstY !== null) window.scrollTo({ top: firstY, left: 0, behavior: 'instant' });

      // Re-verify once after layout has had a chance to settle further -
      // e.g. an image above the target without explicit width/height
      // finishing its async decode and shifting everything below it. Chrome's
      // own scroll anchoring (on by default; this app never sets
      // overflow-anchor: none) already compensates for a lot of this, but
      // re-checking once here is a cheap, explicit backstop rather than
      // relying solely on that.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (restoreAbortedRef.current) return;
      const chapters2 = getChapterElements(contentRef.current);
      const secondY = fragmentY() ?? resolveAnchorToDocumentY(chapters2, toDomAnchor(anchor, firstChapterIndex, chapters2.length), window.scrollY);
      if (secondY !== null && Math.abs(secondY - window.scrollY) > 2) {
        window.scrollTo({ top: secondY, left: 0, behavior: 'instant' });
      }
      jumpFragmentRef.current = undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, restoreTarget, contentRevealed, error]);

  // --- Loading earlier chapters (EPUB opened at a saved position) ---
  useLayoutEffect(() => {
    bookRef.current = book;
    revealedRef.current = contentRevealed;
    settingsRef.current = settings;
    lightboxOpenRef.current = lightbox !== null;
  });

  const loadPrevious = useCallback(async () => {
    const epub = epubRef.current;
    const current = bookRef.current;
    if (!epub || !current || current.firstChapterIndex === 0 || loadingPreviousRef.current || scrollAnchorRef.current) return;

    loadingPreviousRef.current = true;
    const target = current.firstChapterIndex - 1;
    let note: { el: HTMLElement; top: number; firstChapterIndex: number } | null = null;
    try {
      const html = await epub.loadChapter(target);
      if (pdfHandleRef.current) noteScanned(pageKindOfHtml(html));
      // Gone (unmounted, or restarted from the beginning) or already
      // changed while that chapter was loading: drop the result.
      if (epubRef.current !== epub || bookRef.current?.firstChapterIndex !== target + 1 || scrollAnchorRef.current) return;

      // Remember which chapter is at the top of the viewport and exactly
      // where, so the layout effect below can put it back once the new
      // chapter has pushed it down. The chapters mounted keep their keys
      // (their book index), so their DOM nodes survive the insert.
      const chapters = getChapterElements(contentRef.current);
      if (chapters.length > 0) {
        const { index } = findBlockAtY(chapters, 0, (el) => {
          const rect = el.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        });
        const el = chapters[index];
        note = { el, top: el.getBoundingClientRect().top, firstChapterIndex: target };
        scrollAnchorRef.current = note;
      }
      setBook((prev) => {
        if (prev && prev.firstChapterIndex === target + 1) return { ...prev, firstChapterIndex: target, chaptersHtml: [html, ...prev.chaptersHtml] };
        if (scrollAnchorRef.current === note) scrollAnchorRef.current = null; // nothing is going to be committed for that note
        return prev;
      });
    } catch (err) {
      if (!(err instanceof PageCancelledError)) console.error('[ReaderScreen] loading an earlier chapter failed', err);
    } finally {
      loadingPreviousRef.current = false;
    }
  }, []);

  // The chapter after the last one mounted. Appending needs no scroll
  // compensation: nothing above the reader moves.
  const loadNext = useCallback(async () => {
    const epub = epubRef.current;
    const current = bookRef.current;
    if (!epub || !current || loadingNextRef.current) return;
    const target = current.firstChapterIndex + current.chaptersHtml.length;
    if (target >= epub.chapterCount) return;

    loadingNextRef.current = true;
    try {
      const html = await epub.loadChapter(target);
      if (pdfHandleRef.current) noteScanned(pageKindOfHtml(html));
      if (epubRef.current !== epub) return;
      setBook((prev) =>
        prev && prev.firstChapterIndex + prev.chaptersHtml.length === target
          ? { ...prev, chaptersHtml: [...prev.chaptersHtml, html], isComplete: target + 1 >= epub.chapterCount }
          : prev,
      );
    } catch (err) {
      if (!(err instanceof PageCancelledError)) console.error('[ReaderScreen] loading the next chapter failed', err);
    } finally {
      loadingNextRef.current = false;
    }
  }, []);

  // After chapters were inserted above the reading position, or unmounted
  // from above it, scroll by however far the chapter that was on screen
  // moved - measured on the element itself, so it's right whether or not the
  // browser's own scroll anchoring already compensated (then the measured
  // shift is ~0). This runs in the same commit as the change, before the
  // frame is painted: the text on screen never visibly moves.
  useLayoutEffect(() => {
    const pending = scrollAnchorRef.current;
    if (!pending) return;
    scrollAnchorRef.current = null;
    if (book?.firstChapterIndex !== pending.firstChapterIndex || !pending.el.isConnected) return;
    const shift = prependCompensation(pending.top, pending.el.getBoundingClientRect().top);
    if (Math.abs(shift) > 0.5) window.scrollBy({ top: shift, left: 0, behavior: 'instant' });
  }, [book]);

  // Keeps the mounted chapters a window around the reader (see mountWindow.ts): loads the next or the previous chapter
  // while less than a few screens of them remain beyond the screen, and unmounts the ones that are far away, ahead as
  // well as behind. Measured from what is actually on screen. Does one thing per call and is called again after every
  // commit and on every scroll, so it converges; a run of short chapters is filled in without another scroll event.
  const maintainWindow = useCallback(() => {
    const epub = epubRef.current;
    const current = bookRef.current;
    if (!epub || !current || !revealedRef.current || lightboxOpenRef.current || reflowingRef.current > 0 || reflowAnchorRef.current || scrollAnchorRef.current) return;
    const chapters = getChapterElements(contentRef.current);
    // The DOM has not caught up with the state yet: wait for the commit.
    if (chapters.length === 0 || chapters.length !== current.chaptersHtml.length) return;

    const boxes = chapters.map((el) => {
      const rect = el.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    const plan = planWindow({ firstIndex: current.firstChapterIndex, boxes, chapterCount: epub.chapterCount, viewportHeight: window.innerHeight });

    if (plan.dropHead > 0 || plan.dropTail > 0) {
      const firstChapterIndex = current.firstChapterIndex + plan.dropHead;
      const note = plan.dropHead > 0 ? { el: chapters[plan.anchor], top: boxes[plan.anchor].top, firstChapterIndex } : null;
      if (note) scrollAnchorRef.current = note;
      const count = current.chaptersHtml.length;
      setBook((prev) => {
        if (!prev || prev.firstChapterIndex !== current.firstChapterIndex || prev.chaptersHtml.length !== count) {
          // The book changed before this could be applied (a chapter arrived meanwhile): nothing will be committed for
          // this note, and the next run plans afresh.
          if (note && scrollAnchorRef.current === note) scrollAnchorRef.current = null;
          return prev;
        }
        return {
          ...prev,
          firstChapterIndex,
          chaptersHtml: prev.chaptersHtml.slice(plan.dropHead, count - plan.dropTail),
          isComplete: plan.dropTail > 0 ? false : prev.isComplete,
        };
      });
      return;
    }
    if (plan.loadPrevious) void loadPrevious();
    if (plan.loadNext) void loadNext();
  }, [loadPrevious, loadNext]);

  // Runs the window manager after every change to what is mounted and on every scroll (once a frame at most).
  useEffect(() => {
    if (!contentRevealed || !epubRef.current) return;
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        maintainWindow();
      });
    };
    window.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      window.removeEventListener('scroll', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [contentRevealed, book, lightbox, windowTick, maintainWindow]);

  function handleStartFromBeginning() {
    // Opened partway into an EPUB: chapter 0 isn't mounted, so reopen from
    // the start, ignoring the saved position. (A PDF, or an EPUB that was
    // already mounted from chapter 0, only needs the overlay dismissed.)
    if (book && book.firstChapterIndex > 0) {
      setJump(null);
      setSkipRestore(true);
      return;
    }
    restoreAbortedRef.current = true;
    setContentRevealed(true);
  }

  // Reads the current reading position from the live DOM, in book terms
  // (chapter index in the book, never DOM order - the DOM may hold only a
  // window of the book), plus the overall progress derived from it.
  const measureAnchor = useCallback((): { anchor: Anchor; progressFraction: number } | null => {
    const chapters = getChapterElements(contentRef.current);
    const domAnchor = computeAnchor(chapters, 0);
    if (!domAnchor) return null;

    const firstChapterIndex = bookRef.current?.firstChapterIndex ?? 0;
    const anchor = toAbsoluteAnchor(domAnchor, firstChapterIndex);
    const chapterEl = chapters[domAnchor.chapterIndex];
    const blockCount = chapterEl ? flattenToLeafBlocks(chapterEl).length : 0;
    const total = totalChapters ?? firstChapterIndex + chapters.length;
    // An EPUB's progress is weighted by chapter size (a short interlude counts for less than a long
    // chapter); a PDF, or a book whose sizes are unknown, counts chapters equally.
    const progressFraction = weightsRef.current
      ? weightedProgress(weightsRef.current, anchor.chapterIndex, blockCount > 0 ? (anchor.blockIndex + anchor.blockFraction) / blockCount : 0, total)
      : computeProgressFraction(anchor, blockCount, total);
    return { anchor, progressFraction };
  }, [totalChapters]);

  // Computes the current reading anchor from the live DOM and saves it.
  // Shared by the debounced scroll-save and every "guaranteed flush" point
  // that can still safely measure the DOM (back-to-library, app
  // backgrounding) - unmount uses the cached anchor instead (see the load
  // effect's cleanup), since its DOM may already be gone.
  const flushFresh = useCallback(() => {
    const measured = measureAnchor();
    if (!measured) return;
    anchorRef.current = measured.anchor;
    progressFractionRef.current = measured.progressFraction;
    savePosition(file, measured.anchor, measured.progressFraction).catch((err) => console.error('[ReaderScreen] savePosition failed', err));
  }, [file, measureAnchor]);

  // Remembers where the reader is without saving it. A rotation or a resize
  // only tells us AFTER the layout has already moved, so the position from
  // just before it has to be on hand already.
  const cacheAnchor = useCallback(() => {
    const measured = measureAnchor();
    if (!measured) return;
    anchorRef.current = measured.anchor;
    progressFractionRef.current = measured.progressFraction;
  }, [measureAnchor]);

  // Scrolls so that `anchor` (book-relative) is back at the top of the screen.
  const restoreAnchor = useCallback((anchor: Anchor) => {
    const chapters = getChapterElements(contentRef.current);
    const y = anchorScrollTarget(chapters, anchor, bookRef.current?.firstChapterIndex ?? 0, window.scrollY);
    if (y !== null && needsScroll(window.scrollY, y)) window.scrollTo({ top: y, left: 0, behavior: 'instant' });
  }, []);

  // --- Table of contents: opening the drawer and jumping ---
  function openToc() {
    // Measured now, not taken from the last debounced save, so "current" is exactly where the reader is.
    const measured = measureAnchor();
    setTocView({ chapterIndex: measured?.anchor.chapterIndex ?? 0, progress: measured?.progressFraction ?? progressFractionRef.current });
    setShowSettings(false);
    setTocOpen(true);
  }

  // Scrolls an already-mounted chapter (or a spot inside it) to the top of the screen, checks once more
  // after layout has settled, then saves that as the reading position.
  async function landOnChapter(chapterIndex: number, fragment: string | undefined): Promise<void> {
    const target = () => {
      const first = bookRef.current?.firstChapterIndex ?? 0;
      const chapterEl = getChapterElements(contentRef.current)[chapterIndex - first];
      if (!chapterEl) return null;
      return fragmentDocumentY(contentRef.current, chapterIndex, first, fragment) ?? chapterEl.getBoundingClientRect().top + window.scrollY;
    };
    const first = target();
    if (first === null) return;
    window.scrollTo({ top: Math.max(0, first), left: 0, behavior: 'instant' });
    setNavVisible(false);
    await nextFrames(2);
    const second = target();
    if (second !== null && Math.abs(second - window.scrollY) > 2) window.scrollTo({ top: Math.max(0, second), left: 0, behavior: 'instant' });
    flushFresh();
  }

  // Goes to where a tapped internal link points, by the same path as a Contents entry - so the same rules apply
  // (scroll when the chapter is mounted and near, reopen the window at it when not). False if it points nowhere.
  function followInternalLink(anchorId: string | null): boolean {
    const target = anchorId ? epubRef.current?.resolveLink?.(anchorId) : null;
    if (!target) return false;
    jumpToTocItem({ id: `link:${anchorId}`, title: '', chapterIndex: target.chapterIndex, fragment: target.fragment, depth: 0, children: [] });
    return true;
  }

  function jumpToTocItem(item: TocItem) {
    setTocOpen(false);
    const current = bookRef.current;
    if (!current) return;
    const first = current.firstChapterIndex;
    // Already mounted: scroll to it - unless it is so far down the page that the browser would not paint it
    // (see MAX_DIRECT_JUMP_OFFSET_PX; the window keeps the page far below that, so this is a backstop), in which case the
    // window is reopened at it, like a chapter that is not mounted.
    if (item.chapterIndex >= first && item.chapterIndex < first + current.chaptersHtml.length) {
      const chapterEl = getChapterElements(contentRef.current)[item.chapterIndex - first];
      const top = chapterEl ? chapterEl.getBoundingClientRect().top + window.scrollY : null;
      if (canScrollWithinWindow(top)) {
        void landOnChapter(item.chapterIndex, item.fragment);
        return;
      }
    }
    if (pdfHandleRef.current) {
      // A PDF page outside the window: extract that page (and its neighbours) now and move the window there. The document is
      // already open, so nothing is reopened and nothing between here and there is read.
      void relocatePdfWindow(item);
      return;
    }
    // Outside the mounted window (far ahead, or before it): reopen the window at that chapter, exactly as a
    // saved position does - nothing before it is parsed.
    jumpFragmentRef.current = item.fragment;
    savePositionAfterJumpRef.current = true;
    setJump({ chapterIndex: item.chapterIndex, fragment: item.fragment });
  }

  // A jump to a PDF page that is not mounted. The page's text is extracted on demand - the target first, then its neighbours -
  // the mounted window is replaced by one around it, and the reader is put at the page by the same path as a saved position.
  // Normally this takes a frame or two; the "Getting to ..." bar is only a fallback for a page that is slow to extract.
  async function relocatePdfWindow(item: TocItem) {
    const pages = epubRef.current as PdfBook | null;
    if (!pages) return;
    const token = ++relocateTokenRef.current;
    pages.cancelPending(); // pages the reader no longer needs must not queue ahead of this one
    const count = pages.chapterCount;
    const target = Math.min(Math.max(item.chapterIndex, 0), count - 1);
    const start = restoreWindowStart(target, count);
    const end = Math.min(count, Math.max(start + INITIAL_CHAPTER_BATCH, target + 1));
    const barTimer = setTimeout(() => {
      if (relocateTokenRef.current === token) setJumpWait(item);
    }, JUMP_WAIT_BAR_DELAY_MS);
    try {
      // The target is asked for first so it is the first one extracted.
      const indexes = [target, ...Array.from({ length: end - start }, (_, k) => start + k).filter((index) => index !== target)];
      const loaded = await Promise.all(indexes.map((index) => pages.loadChapter(index)));
      if (relocateTokenRef.current !== token || epubRef.current !== pages) return;
      const htmls = new Map(indexes.map((index, k) => [index, loaded[k]] as const));
      for (const html of loaded) noteScanned(pageKindOfHtml(html));
      restoreAbortedRef.current = false;
      restoreStartedRef.current = false;
      jumpFragmentRef.current = undefined;
      savePositionAfterJumpRef.current = true;
      setRelocating(true);
      setRestoreTarget({ anchor: { chapterIndex: target, blockIndex: 0, blockFraction: 0 }, anchorVersion: ANCHOR_VERSION, name: file.name, size: file.size, savedAt: Date.now() });
      setContentRevealed(false);
      setBook((prev) =>
        prev ? { ...prev, firstChapterIndex: start, chaptersHtml: Array.from({ length: end - start }, (_, k) => htmls.get(start + k) ?? ''), isComplete: end >= count } : prev,
      );
    } catch (err) {
      if (!(err instanceof PageCancelledError)) console.error('[ReaderScreen] could not get to that page', err);
    } finally {
      clearTimeout(barTimer);
      if (relocateTokenRef.current === token) setJumpWait(null);
    }
  }

  function cancelJumpWait() {
    relocateTokenRef.current++;
    setJumpWait(null);
  }

  // The reopened window has been revealed at the jump target: save it as the new position.
  useEffect(() => {
    if (!contentRevealed || !savePositionAfterJumpRef.current) return;
    savePositionAfterJumpRef.current = false;
    setRelocating(false);
    setNavVisible(false);
    const frame = requestAnimationFrame(() => flushFresh());
    return () => cancelAnimationFrame(frame);
  }, [contentRevealed, flushFresh]);

  // Lets table adaptation change heights (a wide table becoming cards, say)
  // above the reading position without moving the text on screen: note the
  // anchor, do the writes, scroll back to it. Not before the first reveal,
  // when the position is still being restored.
  preserveViewRef.current = (work) => {
    if (!revealedRef.current) work();
    else preserveAnchorDuring(() => getChapterElements(contentRef.current), work);
  };

  // Waits for the fonts the new layout uses, so it is measured with the real
  // glyph metrics and not a fallback's.
  async function settleFonts(forSettings: ReaderSettings) {
    if (!('fonts' in document)) return;
    await withTimeout(document.fonts.ready, FONT_WAIT_TIMEOUT_MS);
    try {
      await withTimeout(document.fonts.load(`${forSettings.fontSize}px ${FONT_FAMILY_STACKS[forSettings.fontFamily]}`), FONT_WAIT_TIMEOUT_MS);
    } catch {
      // Best effort.
    }
  }

  const nextFrames = (count: number) =>
    new Promise<void>((resolve) => {
      const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
      step(count);
    });

  // After a layout change: wait for fonts, re-adapt the tables for the new
  // measure (without their own view-keeping - we restore explicitly), scroll
  // back to the passage that was captured BEFORE the change, then once more
  // after two frames, for whatever settled late.
  const reflowAndRestore = useCallback(
    async (anchor: Anchor | null, forSettings: ReaderSettings) => {
      const token = ++reflowTokenRef.current;
      reflowingRef.current++;
      try {
        await settleFonts(forSettings);
        await tableController?.reevaluate({ preserveView: false });
        if (token !== reflowTokenRef.current) return;
        if (anchor) restoreAnchor(anchor);
        await nextFrames(2);
        if (token !== reflowTokenRef.current) return;
        if (anchor) restoreAnchor(anchor);
        if (reflowAnchorRef.current === anchor) reflowAnchorRef.current = null;
        cacheAnchor();
      } finally {
        reflowingRef.current--;
        if (reflowingRef.current === 0) setWindowTick((tick) => tick + 1);
      }
    },
    // settleFonts/nextFrames are stable in behavior; restoreAnchor and cacheAnchor carry the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tableController, restoreAnchor, cacheAnchor],
  );

  // --- Tables: one controller for the screen's lifetime ---
  useEffect(() => {
    const controller = new TableAdaptController({
      preserveView: (work) => preserveViewRef.current(work),
      onExpand: (table) => setLightbox({ kind: 'table', node: cloneForGrid(table) }),
    });
    setTableController(controller);
    return () => {
      controller.destroy();
      setTableController(null);
    };
  }, []);

  // A layout-affecting setting changed (the anchor was captured in
  // updateSettings, before it applied): wait for the new layout, then put the
  // reader back on the same passage.
  useEffect(() => {
    const anchor = reflowAnchorRef.current;
    if (!anchor) return;
    void reflowAndRestore(anchor, settings);
    // Only layout-affecting settings are listed on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.fontSize, settings.lineHeight, settings.fontFamily, settings.theme]);

  // Rotation, split-screen, a foldable opening: the reader column's width
  // changed. Re-adapt the tables for the new width and restore the position
  // from just before it (the cached anchor).
  const hasBook = book !== null;
  useEffect(() => {
    const element = contentRef.current;
    if (!contentRevealed || !element) return;
    return watchWidth(element, () => {
      void reflowAndRestore(anchorRef.current, settingsRef.current);
    });
  }, [contentRevealed, hasBook, reflowAndRestore]);

  // The position at the moment the content is revealed is the baseline the
  // first rotation will restore to.
  useEffect(() => {
    if (!contentRevealed) return;
    const frame = requestAnimationFrame(cacheAnchor);
    return () => cancelAnimationFrame(frame);
  }, [contentRevealed, cacheAnchor]);

  // Hardware Back closes whatever is open on top of the page first - the Contents drawer, the
  // expanded table or picture - before it leaves the book.
  const closeLightbox = useCallback(() => setLightbox(null), []);
  const closeToc = useCallback(() => setTocOpen(false), []);
  const closeTopOverlay = useCallback(() => {
    setLightbox(null);
    setTocOpen(false);
  }, []);
  // The pictures a full-screen viewer is showing are held in the store while it is open (and the mounted chapters are
  // left alone, see maintainWindow), so unmounting the chapter they came from can never pull one out from under it.
  useEffect(() => {
    const store = epubRef.current?.images;
    if (!lightbox || !store) return;
    const srcs = lightbox.kind === 'image' ? [lightbox.src] : Array.from(lightbox.node.querySelectorAll('img')).map((img) => img.getAttribute('src') ?? '');
    return store.hold(srcs);
  }, [lightbox]);
  const overlayOpen = lightbox !== null || tocOpen;
  useEffect(() => {
    if (!overlayOpen || !overlayCloseRef) return;
    overlayCloseRef.current = closeTopOverlay;
    return () => {
      if (overlayCloseRef.current === closeTopOverlay) overlayCloseRef.current = null;
    };
  }, [overlayOpen, overlayCloseRef, closeTopOverlay]);

  // Debounced save while actively reading. Deliberately a separate,
  // independent effect from the nav auto-hide timer below - it must never
  // call setNavVisible or touch idleTimerRef, so scrolling to save a
  // position can't reset the idle timer or fight the tap-to-toggle nav.
  // Gated on contentRevealed: during an active restore the DOM is either
  // mid-stream or sitting at a pre-restore scroll position, neither of
  // which is a real reading position worth saving.
  useEffect(() => {
    if (!contentRevealed || !book) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let cacheTimer: ReturnType<typeof setTimeout> | null = null;
    function handleScroll() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushFresh, SAVE_DEBOUNCE_MS);
      if (cacheTimer) clearTimeout(cacheTimer);
      cacheTimer = setTimeout(cacheAnchor, ANCHOR_CACHE_MS);
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (cacheTimer) clearTimeout(cacheTimer);
    };
  }, [contentRevealed, book, flushFresh, cacheAnchor]);

  // App backgrounding - same gating reasoning as the scroll listener above:
  // only meaningful once there's an actual reading position to flush.
  useEffect(() => {
    if (!contentRevealed) return;

    const listenerPromise = CapacitorApp.addListener('appStateChange', (state) => {
      if (!state.isActive) flushFresh();
    });
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') flushFresh();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      listenerPromise.then((listener) => listener.remove());
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [contentRevealed, flushFresh]);

  const handleBack = useCallback(() => {
    if (contentRevealed) flushFresh();
    onBack();
  }, [contentRevealed, flushFresh, onBack]);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  // Auto-hides the nav bar after a few seconds idle, standard reading-app
  // behavior. Doesn't run while there's nothing to read yet (loading/error),
  // or while the settings panel is open - hiding the controls the user is
  // actively adjusting would be a bad experience.
  useEffect(() => {
    clearIdleTimer();
    if (navVisible && book && !showSettings) {
      idleTimerRef.current = setTimeout(() => setNavVisible(false), NAV_IDLE_MS);
    }
    return clearIdleTimer;
  }, [navVisible, showSettings, book, clearIdleTimer]);

  // Only attached to the reading content itself (see JSX below), never to the
  // header or settings panel - those are separate, visually-stacked-on-top
  // elements, so a tap physically on one of them never reaches this handler
  // in the first place. A tap while the settings panel is open dismisses the
  // panel first, matching "tap outside to dismiss"; only a subsequent tap
  // toggles the nav bar itself.
  function handleContentTap(event: ReactMouseEvent<HTMLDivElement>) {
    if (showSettings) {
      setShowSettings(false);
      return;
    }
    // A tap on a picture in the book opens it full screen instead of toggling the header.
    if (event.target instanceof HTMLImageElement && openImageInLightbox(event.target)) return;
    // A tap on an internal link (a Word footnote, a cross-reference) jumps to what it points at.
    const linkEl = event.target instanceof Element ? event.target.closest(`[${LINK_ATTR}]`) : null;
    if (linkEl && followInternalLink(linkEl.getAttribute(LINK_ATTR))) return;
    setNavVisible((visible) => !visible);
  }

  // Pictures smaller than this on both sides are decoration (a flourish, an icon): tapping one is
  // just a tap on the page.
  const MIN_OPENABLE_SIDE_PX = 64;

  function openImageInLightbox(img: HTMLImageElement): boolean {
    const store = epubRef.current?.images;
    const src = img.getAttribute('src');
    const info = store && src ? store.describe(src) : null;
    if (!store || !src || !info?.width || !info.height) return false; // not one of the book's pictures (or its size is unknown)
    if (img.style.display === 'inline-block') return false; // sits inside a line of text
    if (info.width < MIN_OPENABLE_SIDE_PX && info.height < MIN_OPENABLE_SIDE_PX) return false;

    setLightbox({
      kind: 'image',
      // Until the full-detail copy is ready, the picture as it is in the page (if it has been downscaled yet).
      image: { src: store.isPending(src) ? undefined : src, width: info.width, height: info.height, alt: img.alt },
      loadFull: () => store.full(src),
      src,
    });
    return true;
  }

  function toggleSettings() {
    setShowSettings((s) => !s);
    setNavVisible(true);
  }

  function updateSettings(patch: Partial<ReaderSettings>) {
    // About to change something that can move text: note where the reader is
    // NOW, while the DOM still has the old layout. (Kept if one is already
    // pending, so a quick run of taps restores to where the first one began.)
    if (settingsAffectLayout(settingsRef.current, { ...settingsRef.current, ...patch }) && reflowAnchorRef.current === null && revealedRef.current) {
      reflowAnchorRef.current = measureAnchor()?.anchor ?? null;
    }
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveReaderSettings(next);
      return next;
    });
  }

  const themeColors =
    settings.theme === 'custom'
      ? { background: settings.customBackground, text: settings.customText }
      : THEME_COLORS[settings.theme];
  // Page background + status/navigation bars follow the reading theme.
  useSystemTheme(themeColors.background, themeColors.text);

  const contentStyle: CSSProperties = {
    fontFamily: FONT_FAMILY_STACKS[settings.fontFamily],
    fontSize: `${settings.fontSize}px`,
    lineHeight: settings.lineHeight,
  };

  // The Contents button appears only once the book has a table of contents worth opening.
  const hasToc = contentRevealed && toc !== null && flattenToc(toc).length > 1;
  const jumping = (jump !== null && !skipRestore) || relocating;
  const showRestoreOverlay = Boolean(restoreTarget) && !contentRevealed && !error;
  const restoreTargetChapterNumber = restoreTarget ? restoreTarget.anchor.chapterIndex + 1 : 0;
  const restoreParsedSoFar = Math.min((book?.firstChapterIndex ?? 0) + (book?.chaptersHtml.length ?? 0), restoreTargetChapterNumber);

  return (
    <div className="reader" data-theme={settings.theme} style={{ background: themeColors.background, color: themeColors.text }}>
      <header
        className={`reader-header${navVisible ? '' : ' hidden'}`}
        style={{ background: themeColors.background, color: themeColors.text }}
      >
        <button className="icon-button" onClick={handleBack}>
          Back
        </button>
        <span className="reader-title">{book?.title ?? file.name}</span>
        <div className="reader-actions">
          {hasToc && (
            <button className="icon-button" onClick={openToc} aria-label="Contents">
              &#9776;
            </button>
          )}
          <button className="icon-button" onClick={toggleSettings}>
            Aa
          </button>
        </div>
      </header>

      {showSettings && (
        <section className="reader-settings" style={{ background: themeColors.background, color: themeColors.text }}>
          <div className="setting-row">
            <span>Font</span>
            <div className="setting-options">
              {FONT_FAMILY_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  className={settings.fontFamily === option.id ? 'active' : ''}
                  style={{ fontFamily: option.stack }}
                  onClick={() => updateSettings({ fontFamily: option.id })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <span>Size</span>
            <div className="setting-options">
              <button onClick={() => updateSettings({ fontSize: Math.max(FONT_SIZE_MIN, settings.fontSize - 1) })}>
                A-
              </button>
              <span className="setting-value">{settings.fontSize}px</span>
              <button onClick={() => updateSettings({ fontSize: Math.min(FONT_SIZE_MAX, settings.fontSize + 1) })}>
                A+
              </button>
            </div>
          </div>

          <div className="setting-row">
            <span>Line height</span>
            <div className="setting-options">
              <button
                onClick={() =>
                  updateSettings({ lineHeight: Math.max(LINE_HEIGHT_MIN, +(settings.lineHeight - 0.1).toFixed(1)) })
                }
              >
                -
              </button>
              <span className="setting-value">{settings.lineHeight.toFixed(1)}</span>
              <button
                onClick={() =>
                  updateSettings({ lineHeight: Math.min(LINE_HEIGHT_MAX, +(settings.lineHeight + 0.1).toFixed(1)) })
                }
              >
                +
              </button>
            </div>
          </div>

          <div className="setting-row">
            <span>Theme</span>
            <div className="setting-options">
              {(['sepia', 'night', 'beige', 'custom'] satisfies ThemeName[]).map((theme) => (
                <button
                  key={theme}
                  className={settings.theme === theme ? 'active' : ''}
                  onClick={() => updateSettings({ theme })}
                >
                  {theme[0].toUpperCase() + theme.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {settings.theme === 'custom' && (
            <div className="setting-row">
              <span>Custom colors</span>
              <div className="setting-options">
                <label>
                  Background
                  <input
                    type="color"
                    value={settings.customBackground}
                    onChange={(e) => updateSettings({ customBackground: e.target.value })}
                  />
                </label>
                <label>
                  Text
                  <input
                    type="color"
                    value={settings.customText}
                    onChange={(e) => updateSettings({ customText: e.target.value })}
                  />
                </label>
              </div>
            </div>
          )}
        </section>
      )}

      {status && <p className="status">{status}</p>}
      {error && <p className="error">{error}</p>}

      {scannedNoticeVisible && (
        <div className="scanned-notice" role="status">
          <span>This looks like a scanned book - pages show as images, so font and size controls won't apply to them.</span>
          <button className="scanned-notice-dismiss" onClick={dismissScannedNotice}>
            Dismiss
          </button>
        </div>
      )}

      {showRestoreOverlay && (
        <div className="restore-overlay" style={{ background: themeColors.background, color: themeColors.text }}>
          <div className="restore-box">
            <span className="spinner" aria-hidden="true" />
            <p className="restore-text">{jumping ? (pdfLoader ? 'Opening that page…' : 'Opening that chapter…') : 'Restoring your place…'}</p>
            <p className="restore-progress">
              Chapter {restoreParsedSoFar} of {totalChapters ?? restoreTargetChapterNumber}
            </p>
            <button className="restore-skip-btn" onClick={handleStartFromBeginning}>
              Start from beginning
            </button>
          </div>
        </div>
      )}

      {book && (
        <div
          ref={contentRef}
          className={`reader-content${contentRevealed ? '' : ' pre-reveal'}`}
          style={contentStyle}
          onClick={handleContentTap}
        >
          <TableAdaptContext.Provider value={tableController}>
            <ImageContext.Provider value={imageController}>
              <PdfPageLoaderContext.Provider value={pdfLoader}>
                <ChapterList firstChapterIndex={book.firstChapterIndex} chaptersHtml={book.chaptersHtml} />
              </PdfPageLoaderContext.Provider>
            </ImageContext.Provider>
          </TableAdaptContext.Provider>
          {!book.isComplete && <p className="loading-more">Loading more…</p>}
        </div>
      )}

      {jumpWait && book && (
        <div className="toc-wait" role="status" style={{ background: themeColors.background, color: themeColors.text }}>
          <span className="spinner" aria-hidden="true" />
          <span className="toc-wait-text">
            Getting to &ldquo;{jumpWait.title}&rdquo; &middot; page {jumpWait.chapterIndex + 1}
          </span>
          <button className="restore-skip-btn" onClick={cancelJumpWait}>
            Cancel
          </button>
        </div>
      )}

      {tocOpen && toc && (
        <TocDrawer
          items={toc}
          currentChapterIndex={tocView.chapterIndex}
          progress={tocView.progress}
          themeStyle={{ background: themeColors.background, color: themeColors.text }}
          onSelect={jumpToTocItem}
          onClose={closeToc}
        />
      )}

      {lightbox?.kind === 'table' && (
        <ImageLightbox
          label="Table"
          onClose={closeLightbox}
          node={lightbox.node}
          contentStyle={{ ...contentStyle, background: themeColors.background, color: themeColors.text }}
        />
      )}
      {lightbox?.kind === 'image' && (
        <ImageLightbox
          label={lightbox.image.alt || 'Image'}
          onClose={closeLightbox}
          image={lightbox.image}
          loadFull={lightbox.loadFull}
          canInvert={isDarkTheme(settings)}
        />
      )}
    </div>
  );
}
