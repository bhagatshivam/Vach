import { useCallback, useEffect, useState } from 'react';
import {
  addFileSources,
  addFolderSource,
  removeSource,
  scanAllSources,
  type LibraryFile,
  type SourceInfo,
} from '../lib/libraryFolder';

interface LibraryScreenProps {
  onOpenBook: (file: LibraryFile) => void;
}

function isReadable(file: LibraryFile): boolean {
  return file.name.toLowerCase().endsWith('.epub');
}

export default function LibraryScreen({ onOpenBook }: LibraryScreenProps) {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [status, setStatus] = useState('Loading...');
  const [error, setError] = useState<string | null>(null);

  const loadLibrary = useCallback(async () => {
    setStatus('Scanning sources...');
    setError(null);
    try {
      const result = await scanAllSources();
      setSources(result.sources);
      setFiles(result.files);
      setStatus(
        result.sources.length === 0
          ? 'No sources added yet.'
          : `${result.sources.length} source(s), ${result.files.length} file(s).`,
      );
    } catch (err) {
      console.error('[LibraryScreen] loadLibrary: failed', err);
      setError(String(err));
      setStatus('Failed to load library.');
    }
  }, []);

  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  async function handleAddFolder() {
    console.log('[LibraryScreen] handleAddFolder: button tapped');
    setStatus('Waiting for folder selection...');
    setError(null);
    try {
      await addFolderSource();
      await loadLibrary();
    } catch (err) {
      console.error('[LibraryScreen] handleAddFolder: failed', err);
      setError(String(err));
      setStatus('Folder selection cancelled or failed.');
    }
  }

  async function handleAddFiles() {
    console.log('[LibraryScreen] handleAddFiles: button tapped');
    setStatus('Waiting for file selection...');
    setError(null);
    try {
      await addFileSources();
      await loadLibrary();
    } catch (err) {
      console.error('[LibraryScreen] handleAddFiles: failed', err);
      setError(String(err));
      setStatus('File selection cancelled or failed.');
    }
  }

  async function handleRemoveSource(uri: string) {
    await removeSource(uri);
    await loadLibrary();
  }

  return (
    <main className="library">
      <h1>Vach</h1>
      <p className="status">{status}</p>
      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button onClick={handleAddFolder}>Add folder</button>
        <button onClick={handleAddFiles}>Add files</button>
      </div>

      {sources.length > 0 && (
        <section>
          <h2>Sources</h2>
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
        </section>
      )}

      <section>
        <h2>Library</h2>
        <ul className="file-list">
          {files.map((file) => {
            const readable = isReadable(file);
            return (
              <li
                key={file.uri}
                className={readable ? 'readable' : 'unreadable'}
                onClick={readable ? () => onOpenBook(file) : undefined}
              >
                <span className="file-name">{file.name}</span>
                <span className="file-path">{file.path}</span>
                {!readable && <span className="file-note">PDF support coming soon</span>}
              </li>
            );
          })}
        </ul>

        {sources.length > 0 && files.length === 0 && (
          <p className="empty">No .pdf or .epub files found in the added sources.</p>
        )}
      </section>
    </main>
  );
}
