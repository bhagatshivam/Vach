import { registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const LOG_TAG = '[libraryFolder]';

export interface LibraryFile {
  name: string;
  uri: string;
  path: string;
  size: number;
}

interface LibraryFolderPlugin {
  pickFolder(): Promise<{ uri: string }>;
  scanFolder(options: { uri: string }): Promise<{ files: LibraryFile[] }>;
  hasPersistedPermission(options: { uri: string }): Promise<{ granted: boolean }>;
}

const LibraryFolder = registerPlugin<LibraryFolderPlugin>('LibraryFolder');

const FOLDER_URI_KEY = 'library_folder_uri';

export async function getSavedFolderUri(): Promise<string | null> {
  const { value } = await Preferences.get({ key: FOLDER_URI_KEY });
  return value;
}

export async function clearSavedFolder(): Promise<void> {
  await Preferences.remove({ key: FOLDER_URI_KEY });
}

export async function pickAndSaveFolder(): Promise<string> {
  console.log(LOG_TAG, 'pickAndSaveFolder: invoking native LibraryFolder.pickFolder()');
  const { uri } = await LibraryFolder.pickFolder();
  console.log(LOG_TAG, 'pickAndSaveFolder: native call resolved, uri =', uri);
  await Preferences.set({ key: FOLDER_URI_KEY, value: uri });
  console.log(LOG_TAG, 'pickAndSaveFolder: saved uri to Preferences');
  return uri;
}

/**
 * Re-checks the saved folder against Android's live persisted-permission
 * list, since the grant can be revoked outside the app (Settings > Apps).
 */
export async function scanSavedFolder(): Promise<{ uri: string; files: LibraryFile[] } | null> {
  const uri = await getSavedFolderUri();
  console.log(LOG_TAG, 'scanSavedFolder: saved uri =', uri);
  if (!uri) return null;

  const { granted } = await LibraryFolder.hasPersistedPermission({ uri });
  console.log(LOG_TAG, 'scanSavedFolder: hasPersistedPermission =', granted);
  if (!granted) {
    await clearSavedFolder();
    return null;
  }

  const { files } = await LibraryFolder.scanFolder({ uri });
  console.log(LOG_TAG, 'scanSavedFolder: scanFolder returned', files.length, 'file(s)');
  return { uri, files };
}
