export type BookFormat = 'epub' | 'pdf';

const EXTENSION_FORMATS: Record<string, BookFormat> = {
  epub: 'epub',
  pdf: 'pdf',
};

/**
 * Detects a book's format from its file name, case-insensitively (".EPUB",
 * ".Pdf", ".epub" all match) - scanned files come from whatever casing the
 * user's own filesystem happens to use, not something this app controls.
 * Returns null for anything else so a caller can decide how to handle an
 * unrecognized extension rather than silently mislabeling it.
 */
export function detectFormat(fileName: string): BookFormat | null {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1 || dot === fileName.length - 1) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return EXTENSION_FORMATS[ext] ?? null;
}

/**
 * Turns a raw file name into a readable title: strips the extension,
 * replaces underscores with spaces (the most common separator in scanned
 * ebook file names), collapses any run of whitespace left behind into a
 * single space, and trims the ends. Pure string formatting - this never
 * touches the actual file name used to open or identify the book, only
 * what's displayed.
 */
export function cleanTitle(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const withoutExt = dot > 0 ? fileName.slice(0, dot) : fileName;
  return withoutExt
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Case-insensitive substring match of a search query against an
 * already-cleaned title - the search box filters on the same title the
 * user actually sees, not the raw file name. An empty/whitespace-only query
 * matches everything, same as not searching at all.
 */
export function matchesQuery(title: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return title.toLowerCase().includes(q);
}
