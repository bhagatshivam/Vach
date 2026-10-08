import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { readFileBase64, type LibraryFile } from '../lib/libraryFolder';
import {
  computeAnchor,
  computeProgressFraction,
  flattenToLeafBlocks,
  resolveAnchorToDocumentY,
  type Anchor,
} from '../lib/readerAnchor';
import { loadPosition, markOpened, savePosition, type StoredPosition } from '../lib/readingPosition';
import {
  DEFAULT_READER_SETTINGS,
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

interface ReaderScreenProps {
  file: LibraryFile;
  onBack: () => void;
}

// epub.ts and pdf.ts intentionally produce this identical shape - a title
// plus an ordered list of already-sanitized chapter HTML strings - so
// everything below (rendering, fonts, themes, auto-hide nav) is written
// once and works for both formats without a fork. isComplete is false
// while chapters are still streaming in behind the ones already shown.
interface ParsedBook {
  title: string;
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

// document.fonts.ready should resolve almost immediately for this app (every
// font is bundled via @fontsource, nothing is fetched over the network), but
// is capped anyway so a restore can never hang indefinitely on it.
const FONT_WAIT_TIMEOUT_MS = 2000;

// Dynamic imports here, not static ones: pdf.js (~2.2MB worker alone) and
// jszip only need to load when a book of that actual format is opened, not
// as part of the app's initial bundle every time - the production build
// flagged the combined bundle size once pdf.js was added statically. The
// dynamic import happens inside the generator body, so it still only runs
// once the generator is actually iterated, not merely constructed.
async function* streamBook(base64: string, fileName: string) {
  if (fileName.toLowerCase().endsWith('.pdf')) {
    const { streamPdf } = await import('../lib/pdf');
    yield* streamPdf(base64, fileName);
    return;
  }
  const { streamEpub } = await import('../lib/epub');
  yield* streamEpub(base64, fileName);
}

const NAV_IDLE_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

function getChapterElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll(':scope > .chapter'));
}

export default function ReaderScreen({ file, onBack }: ReaderScreenProps) {
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

  useEffect(() => {
    getReaderSettings().then(setSettings);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let generator: AsyncGenerator<{ type: 'title'; title: string } | { type: 'total'; count: number } | { type: 'chapter'; html: string }> | null = null;

    // Reset restore state for this specific file - a fresh mount-equivalent
    // each time `file` changes (App.tsx actually unmounts/remounts this
    // component on navigation, but belt-and-suspenders here costs nothing).
    restoreAbortedRef.current = false;
    restoreStartedRef.current = false;
    anchorRef.current = null;
    progressFractionRef.current = 0;
    setRestoreTarget(null);
    setContentRevealed(false);
    setTotalChapters(null);

    async function load() {
      setStatus('Opening book...');
      setError(null);
      setBook(null);
      try {
        console.log('[ReaderScreen] load: reading file', file.uri);
        markOpened(file).catch((err) => console.error('[ReaderScreen] markOpened failed', err));
        const [savedPosition, base64] = await Promise.all([
          loadPosition(file).catch((err) => {
            console.error('[ReaderScreen] loadPosition failed', err);
            return null;
          }),
          readFileBase64(file.uri),
        ]);
        if (cancelled) return;
        if (savedPosition) {
          console.log('[ReaderScreen] load: restoring saved position', savedPosition.anchor);
          setRestoreTarget(savedPosition);
        } else {
          setContentRevealed(true);
        }

        console.log('[ReaderScreen] load: read', base64.length, 'base64 chars, parsing', file.name);
        setStatus('Parsing...');

        generator = streamBook(base64, file.name);
        let title = file.name;
        const initialChapters: string[] = [];
        let revealed = false;

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
          if (savedPosition) {
            // Restoring: every chapter is appended as it arrives, not
            // batched - the content stays hidden behind the overlay until
            // the target chapter shows up regardless, so there's no reason
            // to delay revealing state here the way the normal path does.
            setBook((prev) =>
              prev ? { ...prev, chaptersHtml: [...prev.chaptersHtml, event.html] } : { title, chaptersHtml: [event.html], isComplete: false },
            );
            continue;
          }
          if (!revealed) {
            initialChapters.push(event.html);
            if (initialChapters.length >= INITIAL_CHAPTER_BATCH) {
              revealed = true;
              console.log('[ReaderScreen] load: revealing first', initialChapters.length, 'chapter(s)');
              setBook({ title, chaptersHtml: [...initialChapters], isComplete: false });
              setStatus('');
            }
            continue;
          }
          setBook((prev) => (prev ? { ...prev, chaptersHtml: [...prev.chaptersHtml, event.html] } : prev));
        }

        if (cancelled) return;
        console.log('[ReaderScreen] load: streaming complete');
        if (savedPosition) {
          setBook((prev) => (prev ? { ...prev, isComplete: true } : { title, chaptersHtml: [], isComplete: true }));
          setStatus('');
        } else if (revealed) {
          setBook((prev) => (prev ? { ...prev, isComplete: true } : prev));
        } else {
          // Fewer chapters than INITIAL_CHAPTER_BATCH in the whole book -
          // nothing was revealed yet, so show what we have as already complete.
          setBook({ title, chaptersHtml: initialChapters, isComplete: true });
          setStatus('');
        }
      } catch (err) {
        if (cancelled) return;
        console.error('[ReaderScreen] load: failed', err);
        setError(String(err));
        setStatus('Failed to open book.');
      }
    }

    load();
    return () => {
      cancelled = true;
      // Signals the generator to stop at its next suspension point instead
      // of continuing to parse chapters nobody will ever see, e.g. when the
      // user backs out of a book mid-load.
      generator?.return(undefined);
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
  }, [file]);

  // --- Resolving the restore target once it's available ---
  useEffect(() => {
    if (!restoreTarget || contentRevealed || restoreStartedRef.current || error) return;
    const targetChapterIndex = restoreTarget.anchor.chapterIndex;
    const parsedSoFar = book?.chaptersHtml.length ?? 0;
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

      const chapters = getChapterElements(contentRef.current);
      const firstY = resolveAnchorToDocumentY(chapters, anchor, window.scrollY);
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
      const secondY = resolveAnchorToDocumentY(chapters2, anchor, window.scrollY);
      if (secondY !== null && Math.abs(secondY - window.scrollY) > 2) {
        window.scrollTo({ top: secondY, left: 0, behavior: 'instant' });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, restoreTarget, contentRevealed, error]);

  function handleStartFromBeginning() {
    restoreAbortedRef.current = true;
    setContentRevealed(true);
  }

  // Computes the current reading anchor from the live DOM and saves it.
  // Shared by the debounced scroll-save and every "guaranteed flush" point
  // that can still safely measure the DOM (back-to-library, app
  // backgrounding) - unmount uses the cached anchor instead (see the load
  // effect's cleanup), since its DOM may already be gone.
  const flushFresh = useCallback(() => {
    const chapters = getChapterElements(contentRef.current);
    const anchor = computeAnchor(chapters, 0);
    if (!anchor) return;

    const chapterEl = chapters[anchor.chapterIndex];
    const blockCount = chapterEl ? flattenToLeafBlocks(chapterEl).length : 0;
    const progressFraction = computeProgressFraction(anchor, blockCount, totalChapters ?? chapters.length);

    anchorRef.current = anchor;
    progressFractionRef.current = progressFraction;
    savePosition(file, anchor, progressFraction).catch((err) => console.error('[ReaderScreen] savePosition failed', err));
  }, [file, totalChapters]);

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
    function handleScroll() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushFresh, SAVE_DEBOUNCE_MS);
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [contentRevealed, book, flushFresh]);

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
  function handleContentTap() {
    if (showSettings) {
      setShowSettings(false);
      return;
    }
    setNavVisible((visible) => !visible);
  }

  function toggleSettings() {
    setShowSettings((s) => !s);
    setNavVisible(true);
  }

  function updateSettings(patch: Partial<ReaderSettings>) {
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

  const contentStyle: CSSProperties = {
    fontFamily: FONT_FAMILY_STACKS[settings.fontFamily],
    fontSize: `${settings.fontSize}px`,
    lineHeight: settings.lineHeight,
  };

  const showRestoreOverlay = Boolean(restoreTarget) && !contentRevealed && !error;
  const restoreTargetChapterNumber = restoreTarget ? restoreTarget.anchor.chapterIndex + 1 : 0;
  const restoreParsedSoFar = Math.min(book?.chaptersHtml.length ?? 0, restoreTargetChapterNumber);

  return (
    <div className="reader" style={{ background: themeColors.background, color: themeColors.text }}>
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
          {book.chaptersHtml.map((html, i) => (
            <section key={i} className="chapter" dangerouslySetInnerHTML={{ __html: html }} />
          ))}
          {!book.isComplete && <p className="loading-more">Loading more…</p>}
        </div>
      )}
    </div>
  );
}
