import { registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const LOG_TAG = '[libraryFolder]';

export interface LibraryFile {
  name: string;
  uri: string;
  path: string;
  size: number;
}

export type LibrarySource = { type: 'folder'; uri: string } | { type: 'file'; uri: string };

export interface SourceInfo {
  source: LibrarySource;
  displayName: string;
}

export interface LibraryScanResult {
  sources: SourceInfo[];
  files: LibraryFile[];
}

interface LibraryFolderPlugin {
  pickFolder(): Promise<{ uri: string }>;
  pickFiles(): Promise<{ uris: string[] }>;
  scanFolder(options: { uri: string }): Promise<{ name: string; files: LibraryFile[] }>;
  statFile(options: { uri: string }): Promise<{ file: LibraryFile }>;
  hasPersistedPermission(options: { uri: string }): Promise<{ granted: boolean }>;
}

const LibraryFolder = registerPlugin<LibraryFolderPlugin>('LibraryFolder');

const SOURCES_KEY = 'library_sources';
const LEGACY_FOLDER_URI_KEY = 'library_folder_uri';

/**
 * One-time, silent migration from the Phase 1 single-folder model to the
 * multi-source list. Only does anything on an install that still has the
 * legacy key and no sources list yet; deletes the legacy key afterwards so
 * it never runs again.
 */
async function migrateLegacyFolder(): Promise<void> {
  const { value: existingSources } = await Preferences.get({ key: SOURCES_KEY });
  if (existingSources) return;

  const { value: legacyUri } = await Preferences.get({ key: LEGACY_FOLDER_URI_KEY });
  if (!legacyUri) return;

  console.log(LOG_TAG, 'migrateLegacyFolder: migrating legacy folder uri into sources list');
  const sources: LibrarySource[] = [{ type: 'folder', uri: legacyUri }];
  await Preferences.set({ key: SOURCES_KEY, value: JSON.stringify(sources) });
  await Preferences.remove({ key: LEGACY_FOLDER_URI_KEY });
}

async function getSources(): Promise<LibrarySource[]> {
  await migrateLegacyFolder();
  const { value } = await Preferences.get({ key: SOURCES_KEY });
  if (!value) return [];
  try {
    return JSON.parse(value) as LibrarySource[];
  } catch (err) {
    console.warn(LOG_TAG, 'getSources: failed to parse stored sources, resetting', err);
    return [];
  }
}

async function saveSources(sources: LibrarySource[]): Promise<void> {
  await Preferences.set({ key: SOURCES_KEY, value: JSON.stringify(sources) });
}

export async function addFolderSource(): Promise<void> {
  console.log(LOG_TAG, 'addFolderSource: invoking native pickFolder()');
  const { uri } = await LibraryFolder.pickFolder();
  console.log(LOG_TAG, 'addFolderSource: picked uri =', uri);

  const sources = await getSources();
  if (sources.some((s) => s.uri === uri)) {
    console.log(LOG_TAG, 'addFolderSource: uri already a source, skipping');
    return;
  }
  await saveSources([...sources, { type: 'folder', uri }]);
}

export async function addFileSources(): Promise<void> {
  console.log(LOG_TAG, 'addFileSources: invoking native pickFiles()');
  const { uris } = await LibraryFolder.pickFiles();
  console.log(LOG_TAG, 'addFileSources: picked', uris.length, 'file(s)');
  if (uris.length === 0) return;

  const sources = await getSources();
  const existing = new Set(sources.map((s) => s.uri));
  const additions: LibrarySource[] = uris
    .filter((uri) => !existing.has(uri))
    .map((uri) => ({ type: 'file', uri }) as const);

  if (additions.length === 0) {
    console.log(LOG_TAG, 'addFileSources: all picked uris already sources, skipping');
    return;
  }
  await saveSources([...sources, ...additions]);
}

export async function removeSource(uri: string): Promise<void> {
  console.log(LOG_TAG, 'removeSource:', uri);
  const sources = await getSources();
  await saveSources(sources.filter((s) => s.uri !== uri));
}

/**
 * Scans every persisted source in parallel. A source whose permission grant
 * was revoked outside the app (Settings > Apps), or that otherwise fails to
 * scan, is dropped from the persisted list on its own - one bad source no
 * longer wipes the whole library, unlike the single-folder model. Files from
 * every surviving source are merged and de-duplicated by uri (covers a file
 * that's both added directly and reachable via an added folder).
 */
export async function scanAllSources(): Promise<LibraryScanResult> {
  const sources = await getSources();
  console.log(LOG_TAG, 'scanAllSources: scanning', sources.length, 'source(s)');

  const scanned = await Promise.all(
    sources.map(async (source) => {
      try {
        const { granted } = await LibraryFolder.hasPersistedPermission({ uri: source.uri });
        if (!granted) {
          console.warn(LOG_TAG, 'scanAllSources: permission revoked for', source.uri);
          return null;
        }

        if (source.type === 'folder') {
          const { name, files } = await LibraryFolder.scanFolder({ uri: source.uri });
          return { source, displayName: name, files };
        }

        const { file } = await LibraryFolder.statFile({ uri: source.uri });
        return { source, displayName: file.name, files: [file] };
      } catch (err) {
        console.warn(LOG_TAG, 'scanAllSources: failed to scan source', source.uri, err);
        return null;
      }
    }),
  );

  const valid = scanned.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (valid.length !== sources.length) {
    console.log(LOG_TAG, 'scanAllSources: dropping', sources.length - valid.length, 'unreachable source(s)');
    await saveSources(valid.map((entry) => entry.source));
  }

  const fileMap = new Map<string, LibraryFile>();
  for (const entry of valid) {
    for (const file of entry.files) {
      fileMap.set(file.uri, file);
    }
  }

  return {
    sources: valid.map(({ source, displayName }) => ({ source, displayName })),
    files: Array.from(fileMap.values()),
  };
}
