import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { readFileBase64, type LibraryFile } from '../lib/libraryFolder';
import {
  DEFAULT_READER_SETTINGS,
  FONT_FAMILY_OPTIONS,
  FONT_FAMILY_STACKS,
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
// after that streams in one chapter at a time in the background.
const INITIAL_CHAPTER_BATCH = 4;

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

const FONT_SIZE_MIN = 14;
const FONT_SIZE_MAX = 28;
const LINE_HEIGHT_MIN = 1.2;
const LINE_HEIGHT_MAX = 2.2;
const NAV_IDLE_MS = 3000;

export default function ReaderScreen({ file, onBack }: ReaderScreenProps) {
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS);
  const [book, setBook] = useState<ParsedBook | null>(null);
  const [status, setStatus] = useState('Loading...');
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [navVisible, setNavVisible] = useState(true);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getReaderSettings().then(setSettings);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let generator: AsyncGenerator<{ type: 'title'; title: string } | { type: 'chapter'; html: string }> | null = null;

    async function load() {
      setStatus('Opening book...');
      setError(null);
      setBook(null);
      try {
        console.log('[ReaderScreen] load: reading file', file.uri);
        const base64 = await readFileBase64(file.uri);
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
        if (revealed) {
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
    };
  }, [file]);

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

  return (
    <div className="reader" style={{ background: themeColors.background, color: themeColors.text }}>
      <header
        className={`reader-header${navVisible ? '' : ' hidden'}`}
        style={{ background: themeColors.background, color: themeColors.text }}
      >
        <button className="icon-button" onClick={onBack}>
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

      {book && (
        <div className="reader-content" style={contentStyle} onClick={handleContentTap}>
          {book.chaptersHtml.map((html, i) => (
            <section key={i} className="chapter" dangerouslySetInnerHTML={{ __html: html }} />
          ))}
          {!book.isComplete && <p className="loading-more">Loading more…</p>}
        </div>
      )}
    </div>
  );
}
