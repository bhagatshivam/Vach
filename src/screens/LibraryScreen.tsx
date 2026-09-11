import { useCallback, useEffect, useState } from 'react';
import {
  clearSavedFolder,
  pickAndSaveFolder,
  scanSavedFolder,
  type LibraryFile,
} from '../lib/libraryFolder';

export default function LibraryScreen() {
  const [folderUri, setFolderUri] = useState<string | null>(null);
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [status, setStatus] = useState('Loading...');
  const [error, setError] = useState<string | null>(null);

  const loadSavedFolder = useCallback(async () => {
    setStatus('Checking for a saved folder...');
    setError(null);
    try {
      const result = await scanSavedFolder();
      if (result) {
        setFolderUri(result.uri);
        setFiles(result.files);
        setStatus(`Found ${result.files.length} file(s).`);
      } else {
        setFolderUri(null);
        setFiles([]);
        setStatus('No folder selected yet.');
      }
    } catch (err) {
      setError(String(err));
      setStatus('Failed to load saved folder.');
    }
  }, []);

  useEffect(() => {
    loadSavedFolder();
  }, [loadSavedFolder]);

  async function handlePickFolder() {
    console.log('[LibraryScreen] handlePickFolder: button tapped');
    setStatus('Waiting for folder selection...');
    setError(null);
    try {
      await pickAndSaveFolder();
      console.log('[LibraryScreen] handlePickFolder: pickAndSaveFolder resolved, rescanning');
      await loadSavedFolder();
    } catch (err) {
      console.error('[LibraryScreen] handlePickFolder: failed', err);
      setError(String(err));
      setStatus('Folder selection cancelled or failed.');
    }
  }

  async function handleForget() {
    await clearSavedFolder();
    setFolderUri(null);
    setFiles([]);
    setStatus('Folder access forgotten.');
  }

  return (
    <main className="library">
      <h1>Vach</h1>
      <p className="status">{status}</p>
      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button onClick={handlePickFolder}>
          {folderUri ? 'Change folder' : 'Choose library folder'}
        </button>
        {folderUri && <button onClick={handleForget}>Forget folder</button>}
      </div>

      {folderUri && <p className="folder-uri">Folder: {folderUri}</p>}

      <ul className="file-list">
        {files.map((file) => (
          <li key={file.uri}>
            <span className="file-name">{file.name}</span>
            <span className="file-path">{file.path}</span>
          </li>
        ))}
      </ul>

      {folderUri && files.length === 0 && (
        <p className="empty">No .pdf or .epub files found in this folder.</p>
      )}
    </main>
  );
}
