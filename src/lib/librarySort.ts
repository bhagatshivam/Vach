import { Preferences } from '@capacitor/preferences';
import type { LibraryFile } from './libraryFolder';
import { cleanTitle } from './libraryText';

const SORT_MODE_KEY = 'library_sort_mode';

function isSortMode(value: unknown): value is SortMode {
  return value === 'title' || value === 'recently-read';
}

export async function loadSortMode(): Promise<SortMode> {
  const { value } = await Preferences.get({ key: SORT_MODE_KEY });
  return isSortMode(value) ? value : DEFAULT_SORT_MODE;
}

export async function saveSortMode(mode: SortMode): Promise<void> {
  await Preferences.set({ key: SORT_MODE_KEY, value: mode });
}

export type SortMode = 'title' | 'recently-read';

export const DEFAULT_SORT_MODE: SortMode = 'recently-read';

export const SORT_MODE_OPTIONS: { id: SortMode; label: string }[] = [
  { id: 'recently-read', label: 'Recently read' },
  { id: 'title', label: 'A-Z' },
];

// Intl.Collator with numeric:true is what makes this a *natural* sort -
// "Vol 2" sorts before "Vol 10" because the digit runs are compared as
// numbers, not character-by-character (which would put "10" before "2").
// sensitivity: 'base' makes it case-insensitive, matching how a reader
// thinks about alphabetical order.
const titleCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Compares two already-cleaned titles directly - exported so a caller
 *  sorting a large list can clean each title once up front instead of
 *  re-deriving it on every comparator call during the sort. */
export function compareCleanTitles(a: string, b: string): number {
  return titleCollator.compare(a, b);
}

/**
 * Where a comparator gets per-file data it doesn't own itself - injected
 * rather than this module importing readingPosition.ts directly, so
 * librarySort stays a pure, independently testable module with no storage
 * dependency, and tests can supply fakes instead of going through
 * Preferences.
 *
 * titleOf lets a caller sorting a large list clean each title once up front
 * (see LibraryScreen's filesWithTitle) instead of this module re-deriving
 * it on every comparator call during the sort - the same reason
 * compareCleanTitles takes already-cleaned strings. Falls back to deriving
 * it inline when not provided, so a caller that doesn't care about that
 * optimization (tests, a one-off small list) can omit it.
 */
export interface SortContext {
  lastOpenedAt?: (file: LibraryFile) => number | undefined;
  titleOf?: (file: LibraryFile) => string;
}

function titleFor(file: LibraryFile, ctx: SortContext): string {
  return ctx.titleOf?.(file) ?? cleanTitle(file.name);
}

const SORT_COMPARATORS: Record<SortMode, (a: LibraryFile, b: LibraryFile, ctx: SortContext) => number> = {
  title: (a, b, ctx) => compareCleanTitles(titleFor(a, ctx), titleFor(b, ctx)),
  // Most-recently-opened first. A book that's never been opened sorts after
  // every book that has (there's no "recently" for it), and never-opened
  // books fall back to natural title order among themselves - exactly the
  // "recently read first, everything else alphabetical" ask.
  'recently-read': (a, b, ctx) => {
    const aOpened = ctx.lastOpenedAt?.(a);
    const bOpened = ctx.lastOpenedAt?.(b);
    if (aOpened != null && bOpened != null) return bOpened - aOpened;
    if (aOpened != null) return -1;
    if (bOpened != null) return 1;
    return compareCleanTitles(titleFor(a, ctx), titleFor(b, ctx));
  },
};

export function sortFiles(files: LibraryFile[], mode: SortMode, ctx: SortContext = {}): LibraryFile[] {
  return [...files].sort((a, b) => SORT_COMPARATORS[mode](a, b, ctx));
}
