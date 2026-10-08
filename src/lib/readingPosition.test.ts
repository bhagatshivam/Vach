import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetForTests,
  bookKey,
  ensureIndexLoaded,
  getProgressIndexSync,
  isFinished,
  loadPosition,
  markOpened,
  savePosition,
} from './readingPosition';

beforeEach(() => {
  __resetForTests();
});

afterEach(async () => {
  // Preferences (web impl, backed by localStorage under jsdom) persists
  // across tests in the same file unless cleared.
  localStorage.clear();
});

describe('bookKey', () => {
  it('is stable for the same name+size', () => {
    expect(bookKey({ name: 'book.epub', size: 1000 })).toBe(bookKey({ name: 'book.epub', size: 1000 }));
  });

  it('differs for different sizes with the same name', () => {
    expect(bookKey({ name: 'book.epub', size: 1000 })).not.toBe(bookKey({ name: 'book.epub', size: 2000 }));
  });

  it('differs for different names with the same size', () => {
    expect(bookKey({ name: 'a.epub', size: 1000 })).not.toBe(bookKey({ name: 'b.epub', size: 1000 }));
  });

  it('falls back to a name-only key when size is 0, missing, or invalid', () => {
    const zero = bookKey({ name: 'book.epub', size: 0 });
    const nan = bookKey({ name: 'book.epub', size: NaN });
    const negative = bookKey({ name: 'book.epub', size: -5 });
    expect(zero).toBe(nan);
    expect(zero).toBe(negative);
    // And it should differ from a real positive-size key for the same name.
    expect(zero).not.toBe(bookKey({ name: 'book.epub', size: 500 }));
  });
});

describe('isFinished', () => {
  it('is true at or above the 98% threshold', () => {
    expect(isFinished(0.98)).toBe(true);
    expect(isFinished(1)).toBe(true);
  });

  it('is false below the threshold', () => {
    expect(isFinished(0.97)).toBe(false);
    expect(isFinished(0)).toBe(false);
  });
});

describe('markOpened', () => {
  it('sets lastOpenedAt without creating/touching a saved position', async () => {
    const file = { name: 'book.epub', size: 1000 };
    await markOpened(file);
    await ensureIndexLoaded();

    const index = getProgressIndexSync();
    const entry = index[bookKey(file)];
    expect(entry).toBeDefined();
    expect(entry.progressFraction).toBe(0);
    expect(typeof entry.lastOpenedAt).toBe('number');

    const position = await loadPosition(file);
    expect(position).toBeNull();
  });

  it('preserves an existing progressFraction when re-opening', async () => {
    const file = { name: 'book.epub', size: 1000 };
    await savePosition(file, { chapterIndex: 2, blockIndex: 1, blockFraction: 0.5 }, 0.42);
    await markOpened(file);

    const index = getProgressIndexSync();
    expect(index[bookKey(file)].progressFraction).toBe(0.42);
  });
});

describe('savePosition / loadPosition', () => {
  it('round-trips a saved position', async () => {
    const file = { name: 'book.epub', size: 1000 };
    const anchor = { chapterIndex: 5, blockIndex: 3, blockFraction: 0.75 };
    await savePosition(file, anchor, 0.3);

    const loaded = await loadPosition(file);
    expect(loaded).not.toBeNull();
    expect(loaded!.anchor).toEqual(anchor);
  });

  it('updates the shared in-memory index immediately, before the write settles', async () => {
    const file = { name: 'book.epub', size: 1000 };
    const savePromise = savePosition(file, { chapterIndex: 1, blockIndex: 0, blockFraction: 0 }, 0.55);
    // Deliberately not awaiting savePromise yet - the in-memory mutation
    // happens synchronously relative to the write, not after it settles.
    await ensureIndexLoaded();
    const index = getProgressIndexSync();
    expect(index[bookKey(file)]?.progressFraction).toBe(0.55);
    await savePromise;
  });

  it('returns null for a book with no saved position', async () => {
    const loaded = await loadPosition({ name: 'never-opened.epub', size: 1 });
    expect(loaded).toBeNull();
  });
});

describe('corrupted/invalid stored positions fall back safely', () => {
  it('discards a position with a non-integer chapterIndex', async () => {
    localStorage.setItem(
      'CapacitorStorage.reading_position:' + bookKey({ name: 'x.epub', size: 1 }),
      JSON.stringify({ anchor: { chapterIndex: 1.5, blockIndex: 0, blockFraction: 0 }, name: 'x.epub', size: 1, savedAt: 1 }),
    );
    const loaded = await loadPosition({ name: 'x.epub', size: 1 });
    expect(loaded).toBeNull();
  });

  it('discards a position with an out-of-range blockFraction type', async () => {
    localStorage.setItem(
      'CapacitorStorage.reading_position:' + bookKey({ name: 'y.epub', size: 1 }),
      JSON.stringify({ anchor: { chapterIndex: 1, blockIndex: 0, blockFraction: 'bad' }, name: 'y.epub', size: 1, savedAt: 1 }),
    );
    const loaded = await loadPosition({ name: 'y.epub', size: 1 });
    expect(loaded).toBeNull();
  });

  it('clamps a blockFraction that is numerically out of [0,1]', async () => {
    localStorage.setItem(
      'CapacitorStorage.reading_position:' + bookKey({ name: 'z.epub', size: 1 }),
      JSON.stringify({ anchor: { chapterIndex: 1, blockIndex: 0, blockFraction: 1.4 }, name: 'z.epub', size: 1, savedAt: 1 }),
    );
    const loaded = await loadPosition({ name: 'z.epub', size: 1 });
    expect(loaded!.anchor.blockFraction).toBe(1);
  });

  it('discards completely malformed JSON without throwing', async () => {
    localStorage.setItem('CapacitorStorage.reading_position:' + bookKey({ name: 'w.epub', size: 1 }), 'not json{{{');
    await expect(loadPosition({ name: 'w.epub', size: 1 })).resolves.toBeNull();
  });
});

describe('write serialization', () => {
  it('serializes concurrent saves for different books without losing either', async () => {
    const fileA = { name: 'a.epub', size: 10 };
    const fileB = { name: 'b.epub', size: 20 };

    await Promise.all([
      savePosition(fileA, { chapterIndex: 1, blockIndex: 0, blockFraction: 0 }, 0.1),
      savePosition(fileB, { chapterIndex: 2, blockIndex: 0, blockFraction: 0 }, 0.2),
    ]);

    const posA = await loadPosition(fileA);
    const posB = await loadPosition(fileB);
    expect(posA!.anchor.chapterIndex).toBe(1);
    expect(posB!.anchor.chapterIndex).toBe(2);

    const index = getProgressIndexSync();
    expect(index[bookKey(fileA)].progressFraction).toBe(0.1);
    expect(index[bookKey(fileB)].progressFraction).toBe(0.2);
  });

  // Note: this doesn't spy on the real @capacitor/preferences Preferences
  // object to simulate a mid-chain failure - it's a Proxy (registerPlugin's
  // return value) whose `get` trap always computes its own method closure
  // regardless of what's reassigned onto it, the same issue that made
  // patching CapacitorApp.addListener directly a no-op during the
  // back-button work. enqueueWrite's try/catch is simple enough to verify
  // by inspection instead of fighting that Proxy for marginal benefit.
});
