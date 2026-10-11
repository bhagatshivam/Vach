import { Preferences } from '@capacitor/preferences';
import type { Anchor } from './readerAnchor';
import type { LibraryFile } from './libraryFolder';

const POSITION_KEY_PREFIX = 'reading_position:';
const INDEX_KEY = 'reading_progress_index';

export const FINISHED_THRESHOLD = 0.98;

export interface StoredPosition {
  anchor: Anchor;
  name: string;
  size: number;
  savedAt: number;
}

export interface ProgressEntry {
  lastOpenedAt: number;
  progressFraction: number;
}

export type ProgressIndex = Record<string, ProgressEntry>;

export function isFinished(progressFraction: number): boolean {
  return progressFraction >= FINISHED_THRESHOLD;
}

// djb2 - a small, fast, synchronous, non-cryptographic string hash. This is
// a key-derivation convenience, not a security boundary (nothing
// adversarial is trying to produce a collision), so crypto.subtle.digest's
// async API would only add an await everywhere for no real benefit.
function djb2(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Keyed by name+size, not by content:// URI - a URI can legitimately change
 * for the same logical book (re-adding a moved folder mints a fresh SAF
 * grant), which would silently orphan a position keyed by URI. Keying by
 * name+size means the position survives a re-add. The flip side (two
 * different books that happen to share both a file name and an exact byte
 * size) is a real but low-probability collision, accepted as a deliberate
 * tradeoff rather than tracked separately.
 *
 * size 0/missing/invalid falls back to a name-only key - a stat failure
 * that produced a bogus size shouldn't be treated as a meaningful
 * distinguishing value.
 */
export function bookKey(file: Pick<LibraryFile, 'name' | 'size'>): string {
  const hasUsableSize = typeof file.size === 'number' && Number.isFinite(file.size) && file.size > 0;
  const basis = hasUsableSize ? `${file.name}\u0000${file.size}` : file.name;
  return djb2(basis);
}

function isFiniteNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

/**
 * Validates and clamps a loaded StoredPosition, same discipline as
 * readerSettings.ts's validateReaderSettings - any wrong-shaped or corrupt
 * field means the whole thing is discarded (null), never a half-trusted
 * value that could scroll to a nonsense position.
 */
function validateStoredPosition(raw: unknown): StoredPosition | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<StoredPosition> & { anchor?: Partial<Anchor> };
  if (!v.anchor || typeof v.anchor !== 'object') return null;
  if (!isFiniteNonNegativeInt(v.anchor.chapterIndex)) return null;
  if (!isFiniteNonNegativeInt(v.anchor.blockIndex)) return null;
  if (typeof v.anchor.blockFraction !== 'number' || !Number.isFinite(v.anchor.blockFraction)) return null;
  if (typeof v.name !== 'string') return null;
  if (typeof v.size !== 'number' || !Number.isFinite(v.size)) return null;
  if (typeof v.savedAt !== 'number' || !Number.isFinite(v.savedAt)) return null;

  return {
    anchor: {
      chapterIndex: v.anchor.chapterIndex,
      blockIndex: v.anchor.blockIndex,
      blockFraction: Math.min(1, Math.max(0, v.anchor.blockFraction)),
    },
    name: v.name,
    size: v.size,
    savedAt: v.savedAt,
  };
}

function validateProgressEntry(raw: unknown): ProgressEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<ProgressEntry>;
  if (typeof v.lastOpenedAt !== 'number' || !Number.isFinite(v.lastOpenedAt)) return null;
  if (typeof v.progressFraction !== 'number' || !Number.isFinite(v.progressFraction)) return null;
  return { lastOpenedAt: v.lastOpenedAt, progressFraction: Math.min(1, Math.max(0, v.progressFraction)) };
}

function validateProgressIndex(raw: unknown): ProgressIndex {
  if (!raw || typeof raw !== 'object') return {};
  const result: ProgressIndex = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = validateProgressEntry(value);
    if (entry) result[key] = entry;
  }
  return result;
}

// Module-level singleton: loaded once, mutated in place by every
// markOpened()/savePosition() call, read directly by the library screen -
// so returning to the library after reading reflects the update
// immediately, with no extra Preferences round trip.
let indexCache: ProgressIndex | null = null;
let indexLoadPromise: Promise<ProgressIndex> | null = null;

async function loadIndexInternal(): Promise<ProgressIndex> {
  if (indexCache) return indexCache;
  if (!indexLoadPromise) {
    indexLoadPromise = (async () => {
      const { value } = await Preferences.get({ key: INDEX_KEY });
      let parsed: unknown = null;
      if (value) {
        try {
          parsed = JSON.parse(value);
        } catch {
          parsed = null;
        }
      }
      indexCache = validateProgressIndex(parsed);
      return indexCache;
    })();
  }
  return indexLoadPromise;
}

/** Library screen calls this once before first render; safe to call more than once (idempotent after the first load). */
export async function ensureIndexLoaded(): Promise<ProgressIndex> {
  return loadIndexInternal();
}

/** Synchronous read of whatever's currently cached - empty until ensureIndexLoaded() has resolved at least once. */
export function getProgressIndexSync(): ProgressIndex {
  return indexCache ?? {};
}

// Every write - per-book detail or the shared index - chains off this, so
// concurrent saves (e.g. a scroll-debounce flush landing right as a
// back-to-library flush fires) can't interleave and clobber each other on
// disk. A failed write is caught inside run() rather than left to reject
// the chain, so one failure doesn't permanently wedge every write after it.
let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite(fn: () => Promise<void>): Promise<void> {
  const run = async () => {
    try {
      await fn();
    } catch (err) {
      console.error('[readingPosition] write failed', err);
    }
  };
  writeQueue = writeQueue.then(run);
  return writeQueue;
}

export async function loadPosition(file: Pick<LibraryFile, 'name' | 'size'>): Promise<StoredPosition | null> {
  const key = POSITION_KEY_PREFIX + bookKey(file);
  const { value } = await Preferences.get({ key });
  if (!value) return null;
  try {
    return validateStoredPosition(JSON.parse(value));
  } catch {
    return null;
  }
}

/**
 * Records that a book was opened - bumps lastOpenedAt for recently-read
 * sort, without touching any existing saved position or its
 * progressFraction. Call once per open, immediately (before any scrolling
 * has happened).
 */
export async function markOpened(file: Pick<LibraryFile, 'name' | 'size'>): Promise<void> {
  const key = bookKey(file);
  const index = await loadIndexInternal();
  const existing = index[key];
  index[key] = { lastOpenedAt: Date.now(), progressFraction: existing?.progressFraction ?? 0 };
  await enqueueWrite(() => Preferences.set({ key: INDEX_KEY, value: JSON.stringify(index) }));
}

/**
 * Saves a reading position: the full per-book detail (for resuming) and an
 * update to the shared index's progressFraction (for library display).
 * lastOpenedAt is left as whatever markOpened() already set - a position
 * save doesn't re-bump "recently opened".
 */
export async function savePosition(
  file: Pick<LibraryFile, 'name' | 'size'>,
  anchor: Anchor,
  progressFraction: number,
): Promise<void> {
  const key = bookKey(file);
  const stored: StoredPosition = { anchor, name: file.name, size: file.size, savedAt: Date.now() };

  const index = await loadIndexInternal();
  const existing = index[key];
  index[key] = {
    lastOpenedAt: existing?.lastOpenedAt ?? Date.now(),
    progressFraction: Math.min(1, Math.max(0, progressFraction)),
  };

  await enqueueWrite(async () => {
    await Preferences.set({ key: POSITION_KEY_PREFIX + key, value: JSON.stringify(stored) });
    await Preferences.set({ key: INDEX_KEY, value: JSON.stringify(index) });
  });
}

/** Test-only: clears the module-level singleton so tests don't leak state into each other. */
export function __resetForTests(): void {
  indexCache = null;
  indexLoadPromise = null;
  writeQueue = Promise.resolve();
}
