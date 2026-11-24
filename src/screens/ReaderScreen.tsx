import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import type { LibraryFile } from '../lib/libraryFolder';
import { FileTooLargeError, createFileSource } from '../lib/fileBridge';
import type { EpubBook } from '../lib/epub';
import { ChapterList } from '../components/ChapterList';
import ImageLightbox, { type LightboxImage } from '../components/ImageLightbox';
import { ImageContext } from '../components/imageContext';
import { ImageController } from '../lib/imageController';
import type { FullImage } from '../lib/imageProcessor';
import { TableAdaptContext } from '../components/tableAdaptContext';
import { TableAdaptController, cloneForGrid, watchWidth } from '../lib/tableAdapter';
import { anchorScrollTarget, needsScroll, preserveAnchorDuring, settingsAffectLayout } from '../lib/reanchor';
import {
  prependCompensation,
  restoreWindowStart,
  shouldLoadPrevious,
  toAbsoluteAnchor,
  toDomAnchor,
} from '../lib/chapterWindow';
import type { PageKind, ParseEvent, PdfHandle } from '../lib/pdf';
import { PdfPageLoader } from '../lib/pdfPageLoader';
import { pushKind, shouldShowScannedNotice } from '../lib/scannedNotice';
import {
  computeAnchor,
  computeProgressFraction,
  findBlockAtY,
  flattenToLeafBlocks,
  resolveAnchorToDocumentY,
  type Anchor,
} from '../lib/readerAnchor';
import { anchorForRestore, loadPosition, markOpened, savePosition, type StoredPosition } from '../lib/readingPosition';
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
// start: chaptersHtml[k] is chapter firstChapterIndex + k. It begins at 0
// unless an EPUB was opened at a saved position, in which case earlier
// chapters are loaded (prepended) lazily as the reader scrolls up.
interface ParsedBook {
  title: string;
  firstChapterIndex: number;
  chaptersHtml: string[];
  isComplete: boolean;
}

// The first few chapters are buffered and revealed together so the reader
// opens on a fuller screen instead of a single short chapter; everything
// after that streams in one chapter at a time in the background. Not used
// at all when restoring a saved position - see the restoreTarget branch in
// the load effect - every chapter is revealed as it arrives there instead,
// since the restore overlay hides the content regardless until the target
// chapter arrives.
const INITIAL_CHAPTER_BATCH = 4;

// Scroll position is saved this long after scrolling stops, not on every
// scroll event - cheap enough per the anchor's binary search, but no
// reason to write on every frame of a fling.
const SAVE_DEBOUNCE_MS = 500;

// The position is also remembered (not saved) this soon after scrolling stops,
// so a rotation or resize - which only announces itself after the layout has
// already moved - can restore to where the reader was just before it.
const ANCHOR_CACHE_MS = 150;

// Chapters that stream in behind the visible ones are committed to React
// state in batches at most this often, not one setState (and one full
// re-render of the list) per chapter.
const APPEND_FLUSH_MS = 100;

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
// in a long book doesn't first parse everything before it. A PDF still
// streams every page from the start (lazy PDF text is a later phase).
interface OpenedBook {
  pdfHandle: PdfHandle | null;
  /** Random-access chapter loading for earlier chapters; null for a PDF. */
  epub: EpubBook | null;
  stream(startIndex: number): AsyncGenerator<ParseEvent>;
}

async function openBookStream(uri: string, fileName: string, signal: AbortSignal): Promise<OpenedBook> {
  if (fileName.toLowerCase().endsWith('.pdf')) {
    const source = await createFileSource(uri, { signal });
    const { openPdf } = await import('../lib/pdf');
    const handle = await openPdf(source, fileName);
    return { pdfHandle: handle, epub: null, stream: () => handle.streamChapters() };
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
    | { kind: 'image'; image: LightboxImage; loadFull: () => Promise<FullImage | null> }
    | null
  >(null);
  // Kept alive for loading earlier chapters on demand; null for a PDF.
  const epubRef = useRef<EpubBook | null>(null);
  const loadingPreviousRef = useRef(false);
  // The chapter element that was at the top of the viewport just before
  // earlier chapters were inserted above it, and where it was - used to put
  // it back exactly after the insert (see the layout effect below).
  const prependAnchorRef = useRef<{ el: HTMLElement; top: number } | null>(null);

  // --- PDF-specific: on-demand page rasterization ---
  // null for an EPUB (or before the handle is ready); set once openBookStream
  // resolves for a PDF, kept alive until this effect's cleanup destroys it.
  const pdfHandleRef = useRef<PdfHandle | null>(null);
  const pageLoaderRef = useRef<PdfPageLoader | null>(null);
  const pageKindWindowRef = useRef<PageKind[]>([]);
  const scannedNoticeDismissedRef = useRef(false);
  const [scannedNoticeVisible, setScannedNoticeVisible] = useState(false);

  useEffect(() => {
    getReaderSettings().then(setSettings);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let generator: AsyncGenerator<ParseEvent> | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
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
    setImageController(null);
    setLightbox(null);
    loadingPreviousRef.current = false;
    prependAnchorRef.current = null;
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
        if (opened.epub) {
          // Pictures near the screen are downscaled in the background; this
          // book's blob: URLs are revoked when it closes (see the cleanup).
          imageControllerLocal = new ImageController(opened.epub.images);
          setImageController(imageControllerLocal);
        }
        // An EPUB opened at a saved position starts at that chapter (plus
        // the one before it), not at chapter 0. Saved anchors are chapter-
        // relative, so they are valid as-is - nothing before the saved
        // chapter has to be parsed to resolve one.
        const startIndex = opened.epub && savedPosition ? restoreWindowStart(savedPosition.anchor.chapterIndex, opened.epub.chapterCount) : 0;
        generator = opened.stream(startIndex);
        let title = file.name;
        const initialChapters: string[] = [];
        let revealed = false;

        const pendingChapters: string[] = [];
        const flushPending = () => {
          flushTimer = null;
          if (cancelled || pendingChapters.length === 0) return;
          const batch = pendingChapters.splice(0);
          setBook((prev) =>
            prev
              ? { ...prev, chaptersHtml: prev.chaptersHtml.concat(batch) }
              : { title, firstChapterIndex: startIndex, chaptersHtml: batch, isComplete: false },
          );
        };
        const queueChapter = (html: string) => {
          pendingChapters.push(html);
          if (flushTimer === null) flushTimer = setTimeout(flushPending, APPEND_FLUSH_MS);
        };

        for await (const event of generator) {
          if (cancelled) return;
          if (event.type === 'title') {
            title = event.title;
            continue;
          }
          if (event.type === 'total') {
            setTotalChapters(event.count);
            continue;
          }
          // Scanned-book detection: only PDF chapter events carry pageKind
          // at all (epub's ParseEvent has no such field), so this is a
          // no-op for an EPUB.
          if (event.pageKind && !scannedNoticeDismissedRef.current) {
            pageKindWindowRef.current = pushKind(pageKindWindowRef.current, event.pageKind);
            if (shouldShowScannedNotice(pageKindWindowRef.current)) setScannedNoticeVisible(true);
          }
          if (savedPosition) {
            // Restoring: every chapter is appended as it arrives - the
            // content stays hidden behind the overlay until the target
            // chapter shows up regardless, so there's no reason to hold
            // chapters back the way the normal path does.
            queueChapter(event.html);
            continue;
          }
          if (!revealed) {
            initialChapters.push(event.html);
            if (initialChapters.length >= INITIAL_CHAPTER_BATCH) {
              revealed = true;
              console.log('[ReaderScreen] load: revealing first', initialChapters.length, 'chapter(s)');
              setBook({ title, firstChapterIndex: 0, chaptersHtml: [...initialChapters], isComplete: false });
              setStatus('');
            }
            continue;
          }
          queueChapter(event.html);
        }

        if (cancelled) return;
        console.log('[ReaderScreen] load: streaming complete');
        // Commit anything still waiting for the next batch before marking
        // the stream complete, so completion can never overtake a chapter.
        if (flushTimer !== null) clearTimeout(flushTimer);
        flushPending();
        if (savedPosition) {
          setBook((prev) => (prev ? { ...prev, isComplete: true } : { title, firstChapterIndex: startIndex, chaptersHtml: [], isComplete: true }));
          setStatus('');
        } else if (revealed) {
          setBook((prev) => (prev ? { ...prev, isComplete: true } : prev));
        } else {
          // Fewer chapters than INITIAL_CHAPTER_BATCH in the whole book -
          // nothing was revealed yet, so show what we have as already complete.
          setBook({ title, firstChapterIndex: 0, chaptersHtml: initialChapters, isComplete: true });
          setStatus('');
        }
      } catch (err) {
        if (cancelled) return;
        console.error('[ReaderScreen] load: failed', err);
        // FileTooLargeError's message is already a complete, user-facing
        // sentence; String(err) would prefix it with the class name.
        setError(err instanceof FileTooLargeError ? err.message : String(err));
        setStatus('Failed to open book.');
      }
    }

    load();
    return () => {
      cancelled = true;
      if (flushTimer !== null) clearTimeout(flushTimer);
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
  }, [file, skipRestore]);

  // --- PDF-specific: lazy windowed rendering of page-image placeholders ---
  // Runs once content is actually visible (contentRevealed - restoring is
  // done, or there was nothing to restore) and only when this book is a PDF
  // (pdfHandleRef.current is null for an EPUB). Re-scans on every new batch
  // of streamed-in chapters, since each one may have added new
  // `.pdf-page` placeholders that aren't observed yet - scan() itself
  // skips anything already known, so this is cheap to call repeatedly.
  useEffect(() => {
    if (!contentRevealed || !pdfHandleRef.current || !contentRef.current) return;
    const handle = pdfHandleRef.current;
    if (!pageLoaderRef.current) {
      pageLoaderRef.current = new PdfPageLoader({
        container: contentRef.current,
        renderPageImage: (pageNumber, viewportWidthPx, devicePixelRatio) =>
          handle.renderPageImage(pageNumber, viewportWidthPx, devicePixelRatio),
      });
    }
    pageLoaderRef.current.scan();
  }, [contentRevealed, book?.chaptersHtml.length]);

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
      const firstY = resolveAnchorToDocumentY(chapters, toDomAnchor(anchor, firstChapterIndex, chapters.length), window.scrollY);
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
      const secondY = resolveAnchorToDocumentY(chapters2, toDomAnchor(anchor, firstChapterIndex, chapters2.length), window.scrollY);
      if (secondY !== null && Math.abs(secondY - window.scrollY) > 2) {
        window.scrollTo({ top: secondY, left: 0, behavior: 'instant' });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, restoreTarget, contentRevealed, error]);

  // --- Loading earlier chapters (EPUB opened at a saved position) ---
  useLayoutEffect(() => {
    bookRef.current = book;
    revealedRef.current = contentRevealed;
    settingsRef.current = settings;
  });

  const loadPrevious = useCallback(async () => {
    const epub = epubRef.current;
    const current = bookRef.current;
    if (!epub || !current || current.firstChapterIndex === 0 || loadingPreviousRef.current) return;

    loadingPreviousRef.current = true;
    const target = current.firstChapterIndex - 1;
    try {
      const html = await epub.loadChapter(target);
      // Gone (unmounted, or restarted from the beginning) or already
      // changed while that chapter was loading: drop the result.
      if (epubRef.current !== epub || bookRef.current?.firstChapterIndex !== target + 1) return;

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
        prependAnchorRef.current = { el, top: el.getBoundingClientRect().top };
      }
      setBook((prev) =>
        prev && prev.firstChapterIndex === target + 1
          ? { ...prev, firstChapterIndex: target, chaptersHtml: [html, ...prev.chaptersHtml] }
          : prev,
      );
    } catch (err) {
      console.error('[ReaderScreen] loading an earlier chapter failed', err);
    } finally {
      loadingPreviousRef.current = false;
    }
  }, []);

  // After earlier chapters were inserted above the reading position, scroll
  // by however far the chapter that was on screen moved - measured on the
  // element itself, so it's right whether or not the browser's own scroll
  // anchoring already compensated (then the measured shift is ~0).
  useLayoutEffect(() => {
    const pending = prependAnchorRef.current;
    if (!pending) return;
    prependAnchorRef.current = null;
    if (!pending.el.isConnected) return;
    const shift = prependCompensation(pending.top, pending.el.getBoundingClientRect().top);
    if (Math.abs(shift) > 0.5) window.scrollBy({ top: shift, left: 0, behavior: 'instant' });
  }, [book?.firstChapterIndex]);

  // Keeps a couple of screens of earlier chapters loaded above the reader.
  // Re-checks after every prepend (via the dependency), so a run of short
  // chapters is filled in without waiting for another scroll event.
  useEffect(() => {
    if (!contentRevealed || !epubRef.current) return;
    function check() {
      if (shouldLoadPrevious(window.scrollY, window.innerHeight, bookRef.current?.firstChapterIndex ?? 0)) {
        void loadPrevious();
      }
    }
    window.addEventListener('scroll', check, { passive: true });
    check();
    return () => window.removeEventListener('scroll', check);
  }, [contentRevealed, book?.firstChapterIndex, loadPrevious]);

  function handleStartFromBeginning() {
    // Opened partway into an EPUB: chapter 0 isn't mounted, so reopen from
    // the start, ignoring the saved position. (A PDF, or an EPUB that was
    // already mounted from chapter 0, only needs the overlay dismissed.)
    if (book && book.firstChapterIndex > 0) {
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
    const progressFraction = computeProgressFraction(anchor, blockCount, totalChapters ?? firstChapterIndex + chapters.length);
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
      await settleFonts(forSettings);
      await tableController?.reevaluate({ preserveView: false });
      if (token !== reflowTokenRef.current) return;
      if (anchor) restoreAnchor(anchor);
      await nextFrames(2);
      if (token !== reflowTokenRef.current) return;
      if (anchor) restoreAnchor(anchor);
      if (reflowAnchorRef.current === anchor) reflowAnchorRef.current = null;
      cacheAnchor();
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

  // Hardware Back closes the expanded table first.
  const closeLightbox = useCallback(() => setLightbox(null), []);
  const lightboxOpen = lightbox !== null;
  useEffect(() => {
    if (!lightboxOpen || !overlayCloseRef) return;
    overlayCloseRef.current = closeLightbox;
    return () => {
      if (overlayCloseRef.current === closeLightbox) overlayCloseRef.current = null;
    };
  }, [lightboxOpen, overlayCloseRef, closeLightbox]);

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
        <button className="icon-button" onClick={toggleSettings}>
          Aa
        </button>
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
            <p className="restore-text">Restoring your place…</p>
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
              <ChapterList firstChapterIndex={book.firstChapterIndex} chaptersHtml={book.chaptersHtml} />
            </ImageContext.Provider>
          </TableAdaptContext.Provider>
          {!book.isComplete && <p className="loading-more">Loading more…</p>}
        </div>
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
