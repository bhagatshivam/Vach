import type { LibraryFile } from './libraryFolder';
import { cleanTitle } from './libraryText';

// Only 'title' exists today. This is a Record keyed by a union, not an
// if/else on a string, specifically so a future sort mode (Phase 3's
// recently-read, keyed off last-opened timestamps once that's tracked) is
// one new union member and one new comparator entry - every caller of
// sortFiles() keeps working unchanged.
export type SortMode = 'title';

export const DEFAULT_SORT_MODE: SortMode = 'title';

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

const SORT_COMPARATORS: Record<SortMode, (a: LibraryFile, b: LibraryFile) => number> = {
  title: (a, b) => compareCleanTitles(cleanTitle(a.name), cleanTitle(b.name)),
};

export function sortFiles(files: LibraryFile[], mode: SortMode): LibraryFile[] {
  return [...files].sort(SORT_COMPARATORS[mode]);
}
