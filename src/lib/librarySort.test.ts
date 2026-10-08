import { describe, expect, it } from 'vitest';
import { compareCleanTitles, sortFiles } from './librarySort';
import type { LibraryFile } from './libraryFolder';

function file(name: string): LibraryFile {
  return { name, uri: `content://x/${name}`, path: name, size: 0 };
}

describe('compareCleanTitles', () => {
  it('sorts numeric volume numbers naturally, not lexically ("Vol 2" before "Vol 10")', () => {
    expect(compareCleanTitles('Vol 2', 'Vol 10')).toBeLessThan(0);
    expect(compareCleanTitles('Vol 10', 'Vol 2')).toBeGreaterThan(0);
  });

  it('is case-insensitive', () => {
    expect(compareCleanTitles('apple', 'Banana')).toBeLessThan(0);
    expect(compareCleanTitles('Apple', 'apple')).toBe(0);
  });

  it('sorts plain alphabetical titles correctly', () => {
    expect(compareCleanTitles('Archive Notes', 'Blacksmith')).toBeLessThan(0);
  });
});

describe('sortFiles', () => {
  it('sorts files by their cleaned title, naturally ("Vol 2" before "Vol 10")', () => {
    const files = [file('Chronicle_Vol_10.epub'), file('Chronicle_Vol_2.epub'), file('Chronicle_Vol_1.epub')];
    const sorted = sortFiles(files, 'title').map((f) => f.name);
    expect(sorted).toEqual(['Chronicle_Vol_1.epub', 'Chronicle_Vol_2.epub', 'Chronicle_Vol_10.epub']);
  });

  it('sorts case-insensitively on the cleaned (underscore-stripped) title, not the raw file name', () => {
    const files = [file('zebra_notes.epub'), file('Apple_Notes.epub'), file('mango_notes.epub')];
    const sorted = sortFiles(files, 'title').map((f) => f.name);
    expect(sorted).toEqual(['Apple_Notes.epub', 'mango_notes.epub', 'zebra_notes.epub']);
  });

  it('does not mutate the input array', () => {
    const files = [file('b.epub'), file('a.epub')];
    const original = [...files];
    sortFiles(files, 'title');
    expect(files).toEqual(original);
  });
});

describe('sortFiles - recently-read', () => {
  function lookup(map: Record<string, number>) {
    return (f: LibraryFile) => map[f.name];
  }

  it('sorts opened books most-recently-opened first', () => {
    const files = [file('a.epub'), file('b.epub'), file('c.epub')];
    const ctx = { lastOpenedAt: lookup({ 'a.epub': 100, 'b.epub': 300, 'c.epub': 200 }) };
    const sorted = sortFiles(files, 'recently-read', ctx).map((f) => f.name);
    expect(sorted).toEqual(['b.epub', 'c.epub', 'a.epub']);
  });

  it('puts never-opened books after every opened book', () => {
    const files = [file('never.epub'), file('opened.epub')];
    const ctx = { lastOpenedAt: lookup({ 'opened.epub': 100 }) };
    const sorted = sortFiles(files, 'recently-read', ctx).map((f) => f.name);
    expect(sorted).toEqual(['opened.epub', 'never.epub']);
  });

  it('falls back to natural title order among never-opened books', () => {
    const files = [file('Chronicle_Vol_10.epub'), file('Chronicle_Vol_2.epub')];
    const sorted = sortFiles(files, 'recently-read', {}).map((f) => f.name);
    expect(sorted).toEqual(['Chronicle_Vol_2.epub', 'Chronicle_Vol_10.epub']);
  });

  it('works with no context at all (defaults to treating every book as never-opened)', () => {
    const files = [file('b.epub'), file('a.epub')];
    const sorted = sortFiles(files, 'recently-read').map((f) => f.name);
    expect(sorted).toEqual(['a.epub', 'b.epub']);
  });
});

describe('sortFiles - titleOf injection', () => {
  it('uses a provided titleOf instead of deriving cleanTitle internally', () => {
    const files = [file('a.epub'), file('b.epub')];
    // Deliberately inverted titles relative to file name order, to prove
    // the comparator is actually using titleOf rather than silently
    // falling back to cleanTitle(file.name).
    const titleOf = (f: LibraryFile) => (f.name === 'a.epub' ? 'Zed' : 'Alpha');
    const sorted = sortFiles(files, 'title', { titleOf }).map((f) => f.name);
    expect(sorted).toEqual(['b.epub', 'a.epub']);
  });

  it('is also used by recently-read for its never-opened fallback ordering', () => {
    const files = [file('a.epub'), file('b.epub')];
    const titleOf = (f: LibraryFile) => (f.name === 'a.epub' ? 'Zed' : 'Alpha');
    const sorted = sortFiles(files, 'recently-read', { titleOf }).map((f) => f.name);
    expect(sorted).toEqual(['b.epub', 'a.epub']);
  });
});
