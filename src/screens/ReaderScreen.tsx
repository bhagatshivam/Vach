import { useEffect, useState, type CSSProperties } from 'react';
import { readFileBase64, type LibraryFile } from '../lib/libraryFolder';
import { parseEpub, type ParsedEpub } from '../lib/epub';
import {
  DEFAULT_READER_SETTINGS,
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

const FONT_SIZE_MIN = 14;
const FONT_SIZE_MAX = 28;
const LINE_HEIGHT_MIN = 1.2;
const LINE_HEIGHT_MAX = 2.2;

export default function ReaderScreen({ file, onBack }: ReaderScreenProps) {
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS);
  const [epub, setEpub] = useState<ParsedEpub | null>(null);
  const [status, setStatus] = useState('Loading...');
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    getReaderSettings().then(setSettings);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus('Opening book...');
      setError(null);
      try {
        console.log('[ReaderScreen] load: reading file', file.uri);
        const base64 = await readFileBase64(file.uri);
        console.log('[ReaderScreen] load: read', base64.length, 'base64 chars, parsing epub');
        const parsed = await parseEpub(base64, file.name);
        if (cancelled) return;
        console.log('[ReaderScreen] load: parsed', parsed.chaptersHtml.length, 'chapter(s)');
        setEpub(parsed);
        setStatus('');
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
    };
  }, [file]);

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
      <header className="reader-header">
        <button className="icon-button" onClick={onBack}>
          Back
        </button>
        <span className="reader-title">{epub?.title ?? file.name}</span>
        <button className="icon-button" onClick={() => setShowSettings((s) => !s)}>
          Aa
        </button>
      </header>

      {showSettings && (
        <section className="reader-settings">
          <div className="setting-row">
            <span>Font</span>
            <div className="setting-options">
              <button
                className={settings.fontFamily === 'serif' ? 'active' : ''}
                onClick={() => updateSettings({ fontFamily: 'serif' })}
              >
                Serif
              </button>
              <button
                className={settings.fontFamily === 'sans' ? 'active' : ''}
                onClick={() => updateSettings({ fontFamily: 'sans' })}
              >
                Sans
              </button>
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

      <div className="reader-scroll">
        {status && <p className="status">{status}</p>}
        {error && <p className="error">{error}</p>}

        {epub && (
          <div className="reader-content" style={contentStyle}>
            {epub.chaptersHtml.map((html, i) => (
              <section key={i} className="chapter" dangerouslySetInnerHTML={{ __html: html }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
