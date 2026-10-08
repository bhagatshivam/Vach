import { useCallback, useEffect, useMemo, useState, type CSSProperties, type RefObject } from 'react';
import {
  addFileSources,
  addFolderSource,
  removeSource,
  scanAllSources,
  type FailedSourceInfo,
  type LibraryFile,
  type SourceInfo,
} from '../lib/libraryFolder';
import { cleanTitle, detectFormat, matchesQuery } from '../lib/libraryText';
import { DEFAULT_SORT_MODE, SORT_MODE_OPTIONS, loadSortMode, saveSortMode, sortFiles, type SortMode } from '../lib/librarySort';
import { bookKey, ensureIndexLoaded, getProgressIndexSync, isFinished } from '../lib/readingPosition';
import { DEFAULT_READER_SETTINGS, THEME_COLORS, getReaderSettings, type ReaderSettings } from '../lib/readerSettings';

interface LibraryScreenProps {
  onOpenBook: (file: LibraryFile) => void;
  /** Set while the sources sheet is open, cleared when it closes or this
   *  component unmounts - lets App.tsx's single hardware-back listener
   *  close the sheet first instead of leaving the screen or exiting. */
  sheetCloseRef: RefObject<(() => void) | null>;
}

// Debounces the *filtering/sorting* of the (potentially large) file list
// behind the user's typing, not the search box's own text - the input
// itself stays perfectly responsive (it's just local state), this only
// delays the expensive part by a tick so fast typing doesn't re-filter the
// whole library on every keystroke.
const SEARCH_DEBOUNCE_MS = 120;

const PERMISSION_REASON_TEXT: Record<FailedSourceInfo['reason'], string> = {
  'permission-revoked': 'permission was revoked',
  'scan-failed': "couldn't be read",
};

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

interface BookRowProps {
  file: LibraryFile;
  title: string;
  /** undefined - never opened/no saved position, so no bar at all, not an empty one. */
  progressFraction: number | undefined;
  onOpen: () => void;
}

function BookRow({ file, title, progressFraction, onOpen }: BookRowProps) {
  const format = detectFormat(file.name);
  const showProgress = typeof progressFraction === 'number' && progressFraction > 0;
  const barPercent = showProgress ? (isFinished(progressFraction) ? 100 : Math.round(progressFraction * 100)) : 0;
  return (
    <li className="book-row" onClick={onOpen}>
      <span className={`fmt-badge${format ? ` ${format}` : ''}`}>{(format ?? '?').toUpperCase()}</span>
      <div className="book-main">
        <span className="book-title">{title}</span>
        <span className="book-meta">{format ? format.toUpperCase() : file.name}</span>
        {/* Always rendered, not conditionally - a book-row's height must stay
            identical whether or not it has progress, which matters once the
            list holds a few thousand rows (see .book-row's own comment).
            visibility:hidden (not a conditional render) reserves the exact
            same space either way. */}
        <span className={`progress-track${showProgress ? '' : ' invisible'}`} aria-hidden="true">
          <span className="progress-fill" style={{ width: `${barPercent}%` }} />
        </span>
      </div>
      <span className="chev" aria-hidden="true">
        &#8250;
      </span>
    </li>
  );
}

export default function LibraryScreen({ onOpenBook, sheetCloseRef }: LibraryScreenProps) {
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [failedSources, setFailedSources] = useState<FailedSourceInfo[]>([]);
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sortMode, setSortModeState] = useState<SortMode>(DEFAULT_SORT_MODE);
  // Bumped whenever the shared in-memory progress index (readingPosition.ts)
  // might have changed - it isn't React state itself, so reading it doesn't
  // automatically trigger a re-render; this is just the signal to re-read it.
  const [progressTick, setProgressTick] = useState(0);

  useEffect(() => {
    getReaderSettings().then(setSettings);
  }, []);

  useEffect(() => {
    loadSortMode().then(setSortModeState);
  }, []);

  useEffect(() => {
    // Resolves immediately from the shared cache if the reader already
    // loaded it this session (e.g. returning from a book just read) - no
    // extra Preferences round trip in that case, per the "no re-read" design.
    ensureIndexLoaded().then(() => setProgressTick((t) => t + 1));
  }, []);

  function handleSortModeChange(mode: SortMode) {
    setSortModeState(mode);
    saveSortMode(mode);
  }

  const loadLibrary = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const result = await scanAllSources();
      setSources(result.sources);
      setFailedSources(result.failedSources);
      setFiles(result.files);
    } catch (err) {
      console.error('[LibraryScreen] loadLibrary: failed', err);
      setError(String(err));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Cleans each title once per files change, not once per keystroke/sort
  // comparison - the thing that actually keeps a few-thousand-book library
  // from making search feel laggy while typing.
  const filesWithTitle = useMemo(() => files.map((file) => ({ file, title: cleanTitle(file.name) })), [files]);

  const visibleFiles = useMemo(() => {
    const matched = filesWithTitle.filter((f) => matchesQuery(f.title, debouncedQuery));
    const titleByUri = new Map(matched.map((f) => [f.file.uri, f.title]));
    const progressIndex = getProgressIndexSync();
    const sorted = sortFiles(
      matched.map((f) => f.file),
      sortMode,
      {
        titleOf: (file) => titleByUri.get(file.uri) ?? file.name,
        lastOpenedAt: (file) => progressIndex[bookKey(file)]?.lastOpenedAt,
      },
    );
    return sorted.map((file) => ({
      file,
      title: titleByUri.get(file.uri) ?? file.name,
      progressFraction: progressIndex[bookKey(file)]?.progressFraction,
    }));
    // progressTick isn't read directly here, but it's what signals that
    // getProgressIndexSync() may now return something different.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesWithTitle, debouncedQuery, sortMode, progressTick]);

  const continueReading = useMemo(() => {
    const progressIndex = getProgressIndexSync();
    let best: { file: LibraryFile; title: string; progressFraction: number; lastOpenedAt: number } | null = null;
    for (const { file, title } of filesWithTitle) {
      const entry = progressIndex[bookKey(file)];
      if (!entry || entry.progressFraction <= 0 || isFinished(entry.progressFraction)) continue;
      if (!best || entry.lastOpenedAt > best.lastOpenedAt) {
        best = { file, title, progressFraction: entry.progressFraction, lastOpenedAt: entry.lastOpenedAt };
      }
    }
    return best;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesWithTitle, progressTick]);

  async function handleAddFolder() {
    console.log('[LibraryScreen] handleAddFolder: button tapped');
    setError(null);
    try {
      await addFolderSource();
      await loadLibrary();
    } catch (err) {
      console.error('[LibraryScreen] handleAddFolder: failed', err);
      setError(String(err));
    }
  }

  async function handleAddFiles() {
    console.log('[LibraryScreen] handleAddFiles: button tapped');
    setError(null);
    try {
      await addFileSources();
      await loadLibrary();
    } catch (err) {
      console.error('[LibraryScreen] handleAddFiles: failed', err);
      setError(String(err));
    }
  }

  async function handleRemoveSource(uri: string) {
    await removeSource(uri);
    await loadLibrary();
  }

  function closeSheet() {
    setSheetOpen(false);
  }

  // Keeps App.tsx's single hardware-back listener in sync with whether the
  // sheet should swallow the next back press. Cleared on unmount so a stale
  // closure can never fire after this screen is gone (e.g. a book opened
  // while the sheet happened to still be mid-close-animation-less toggle).
  useEffect(() => {
    sheetCloseRef.current = sheetOpen ? closeSheet : null;
  }, [sheetOpen, sheetCloseRef]);
  useEffect(() => {
    return () => {
      sheetCloseRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const themeColors = settings.theme === 'custom' ? { background: settings.customBackground, text: settings.customText } : THEME_COLORS[settings.theme];
  const rootStyle: CSSProperties = { background: themeColors.background, color: themeColors.text };

  const isFirstLaunchEmpty = sources.length === 0 && failedSources.length === 0 && !scanning;

  return (
    <div className="library" style={rootStyle}>
      <header className="app-header">
        <div className="wordmark">
          <span className="devanagari">वाच</span>
          <span className="latin">Vach</span>
        </div>
        <button className="icon-btn" onClick={() => setSheetOpen(true)} aria-label="Sources and settings">
          &#9881;
        </button>
      </header>

      {failedSources.map((f) => (
        <div key={f.source.uri} className="perm-banner">
          <span aria-hidden="true">&#9888;</span>
          <span>
            <strong>Can&apos;t access &quot;{f.displayName}&quot;</strong> - {PERMISSION_REASON_TEXT[f.reason]}.
          </span>
          <button className="banner-remove-btn" onClick={() => handleRemoveSource(f.source.uri)}>
            Remove
          </button>
        </div>
      ))}

      {error && <p className="error">{error}</p>}

      {continueReading && (
        <button className="continue-reading" onClick={() => onOpenBook(continueReading.file)}>
          <span className="continue-label">Continue reading</span>
          <span className="continue-title">{continueReading.title}</span>
          <span className="continue-progress">{Math.round(continueReading.progressFraction * 100)}%</span>
        </button>
      )}

      {isFirstLaunchEmpty ? (
        <div className="empty-state">
          <div className="glyph" aria-hidden="true">
            &#128214;
          </div>
          <h2>Your library is empty</h2>
          <p>Add a folder of EPUB or PDF files from your device to start reading. Nothing leaves your phone.</p>
          <button className="primary-btn" onClick={handleAddFolder}>
            + Add folder
          </button>
        </div>
      ) : (
        <>
          <div className="search-wrap">
            <div className="search-box">
              <SearchIcon />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search your library"
                aria-label="Search your library"
              />
              {searchInput && (
                <button className="clear-btn" onClick={() => setSearchInput('')} aria-label="Clear search">
                  &times;
                </button>
              )}
            </div>
          </div>

          {scanning && (
            <div className="scan-row">
              <span className="spinner" aria-hidden="true" /> Scanning your library...
            </div>
          )}

          <div className="list-toolbar">
            <span className="count">
              {visibleFiles.length} book{visibleFiles.length === 1 ? '' : 's'}
            </span>
            <div className="sort-toggle" role="group" aria-label="Sort order">
              {SORT_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  className={sortMode === opt.id ? 'active' : ''}
                  onClick={() => handleSortModeChange(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {visibleFiles.length === 0 && !scanning ? (
            <p className="empty">
              {debouncedQuery ? <>No books match &quot;{debouncedQuery}&quot;.</> : 'No .pdf or .epub files found in the added sources.'}
            </p>
          ) : (
            <ul className="book-list">
              {visibleFiles.map(({ file, title, progressFraction }) => (
                <BookRow key={file.uri} file={file} title={title} progressFraction={progressFraction} onOpen={() => onOpenBook(file)} />
              ))}
            </ul>
          )}
        </>
      )}

      {sheetOpen && (
        <div className="sheet-overlay" onClick={closeSheet}>
          <div className="sheet" style={rootStyle} onClick={(e) => e.stopPropagation()}>
            <div className="sheet-header">
              <h2>Sources</h2>
              <button className="icon-btn" onClick={closeSheet} aria-label="Close">
                &times;
              </button>
            </div>

            <div className="sheet-actions">
              <button onClick={handleAddFolder}>Add folder</button>
              <button onClick={handleAddFiles}>Add files</button>
            </div>

            {sources.length === 0 ? (
              <p className="empty">No sources added yet.</p>
            ) : (
              <ul className="source-list">
                {sources.map(({ source, displayName }) => (
                  <li key={source.uri}>
                    <span className="source-badge">{source.type === 'folder' ? 'Folder' : 'File'}</span>
                    <span className="source-name">{displayName}</span>
                    <button className="remove-button" onClick={() => handleRemoveSource(source.uri)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
