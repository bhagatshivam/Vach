import { describe, expect, it } from 'vitest';
import { cleanTitle, detectFormat, matchesQuery } from './libraryText';

describe('cleanTitle', () => {
  it('strips the extension', () => {
    expect(cleanTitle('my_book.epub')).toBe('my book');
  });

  it('replaces underscores with spaces', () => {
    expect(cleanTitle('a_wanderers_path.epub')).toBe('a wanderers path');
  });

  it('collapses repeated underscores/spaces into a single space', () => {
    expect(cleanTitle('my__book___title.epub')).toBe('my book title');
    expect(cleanTitle('my   book.epub')).toBe('my book');
  });

  it('trims leading/trailing underscores and spaces', () => {
    expect(cleanTitle('_my_book_.epub')).toBe('my book');
  });

  it('leaves a name with no extension untouched (aside from underscore cleanup)', () => {
    expect(cleanTitle('mybook_notes')).toBe('mybook notes');
  });

  it('only strips the last extension when a name contains multiple dots', () => {
    expect(cleanTitle('my.book.v2.epub')).toBe('my.book.v2');
  });

  it('is case-preserving (only whitespace/underscore cleanup, no case changes)', () => {
    expect(cleanTitle('The_Silver_Loom.epub')).toBe('The Silver Loom');
  });
});

describe('detectFormat', () => {
  it('detects epub and pdf, case-insensitively', () => {
    expect(detectFormat('book.epub')).toBe('epub');
    expect(detectFormat('book.EPUB')).toBe('epub');
    expect(detectFormat('book.Epub')).toBe('epub');
    expect(detectFormat('book.pdf')).toBe('pdf');
    expect(detectFormat('book.PDF')).toBe('pdf');
    expect(detectFormat('book.Pdf')).toBe('pdf');
  });

  it('returns null for an unrecognized extension', () => {
    expect(detectFormat('notes.txt')).toBeNull();
  });

  it('returns null for a name with no extension', () => {
    expect(detectFormat('book')).toBeNull();
  });

  it('returns null for a trailing dot with nothing after it', () => {
    expect(detectFormat('book.')).toBeNull();
  });

  it('uses the last extension for a name with multiple dots', () => {
    expect(detectFormat('my.notes.pdf')).toBe('pdf');
  });
});

describe('matchesQuery', () => {
  it('matches a case-insensitive substring', () => {
    expect(matchesQuery('The Silver Loom', 'silver')).toBe(true);
    expect(matchesQuery('The Silver Loom', 'SILVER')).toBe(true);
  });

  it('does not match when the substring is absent', () => {
    expect(matchesQuery('The Silver Loom', 'gold')).toBe(false);
  });

  it('matches a multi-word substring spanning words', () => {
    expect(matchesQuery('Chronicle of the Quiet Star', 'the quiet star')).toBe(true);
  });

  it('treats an empty or whitespace-only query as matching everything', () => {
    expect(matchesQuery('Anything at all', '')).toBe(true);
    expect(matchesQuery('Anything at all', '   ')).toBe(true);
  });
});
