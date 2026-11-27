import { describe, expect, it } from 'vitest';
import { PageCancelledError, PdfPageExtractor } from './pdfPages';

/** An extractor whose jobs finish only when the test says so, recording the order in which they started. */
function gated(concurrency = 1) {
  const started: number[] = [];
  const open = new Map<number, (value: string) => void>();
  const failures = new Map<number, (reason: unknown) => void>();
  const extractor = new PdfPageExtractor<string>(
    (index) =>
      new Promise<string>((resolve, reject) => {
        started.push(index);
        open.set(index, resolve);
        failures.set(index, reject);
      }),
    concurrency,
  );
  const finish = async (index: number) => {
    open.get(index)!(`page ${index}`);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { extractor, started, finish, fail: (index: number, reason: unknown) => failures.get(index)!(reason) };
}

describe('PdfPageExtractor - ordering', () => {
  it('runs one page at a time, in the order asked for', async () => {
    const { extractor, started, finish } = gated();
    const results = [extractor.load(5), extractor.load(6), extractor.load(7)];
    expect(started).toEqual([5]);
    await finish(5);
    expect(started).toEqual([5, 6]);
    await finish(6);
    await finish(7);
    expect(await Promise.all(results)).toEqual(['page 5', 'page 6', 'page 7']);
  });

  it('runs the most urgent waiting page next, whatever order the requests came in', async () => {
    const { extractor, started, finish } = gated();
    void extractor.load(1); // starts at once
    void extractor.load(2, 0);
    void extractor.load(3, 5);
    void extractor.load(4, 1);
    await finish(1);
    expect(started).toEqual([1, 3]);
    await finish(3);
    expect(started).toEqual([1, 3, 4]);
    await finish(4);
    expect(started).toEqual([1, 3, 4, 2]);
  });

  it('moves a waiting page up when it is asked for again more urgently', async () => {
    const { extractor, started, finish } = gated();
    void extractor.load(1);
    void extractor.load(2);
    void extractor.load(3);
    void extractor.load(3, 9);
    await finish(1);
    expect(started).toEqual([1, 3]);
  });

  it('shares one job between two requests for the same page', async () => {
    const { extractor, started, finish } = gated();
    const a = extractor.load(4);
    const b = extractor.load(4);
    expect(a).toBe(b);
    await finish(4);
    expect(started).toEqual([4]);
    expect(await a).toBe('page 4');
  });

  it('extracts a page again when it is asked for after it finished (nothing is cached: the reader holds what it shows)', async () => {
    const { extractor, started, finish } = gated();
    const first = extractor.load(4);
    await finish(4);
    await first;
    const second = extractor.load(4);
    expect(started).toEqual([4, 4]);
    await finish(4);
    expect(await second).toBe('page 4');
    expect(extractor.size).toBe(0);
  });

  it('with a concurrency of 2 two pages run at once', async () => {
    const { extractor, started } = gated(2);
    void extractor.load(1);
    void extractor.load(2);
    void extractor.load(3);
    expect(started).toEqual([1, 2]);
  });
});

describe('PdfPageExtractor - cancellation', () => {
  it('cancelPending drops the pages that have not started, and lets the running one finish', async () => {
    const { extractor, started, finish } = gated();
    const running = extractor.load(1);
    const waiting = extractor.load(2);
    const alsoWaiting = extractor.load(3);
    expect(extractor.cancelPending()).toBe(2);
    await expect(waiting).rejects.toBeInstanceOf(PageCancelledError);
    await expect(alsoWaiting).rejects.toMatchObject({ name: 'PageCancelledError', pageIndex: 3 });
    await finish(1);
    expect(await running).toBe('page 1');
    expect(started).toEqual([1]); // the dropped pages never started
    expect(extractor.size).toBe(0);
  });

  it('a page asked for again after it was cancelled is extracted normally', async () => {
    const { extractor, started, finish } = gated();
    void extractor.load(1);
    void extractor.load(2).catch(() => {});
    extractor.cancelPending();
    await finish(1);
    const again = extractor.load(2);
    expect(started).toEqual([1, 2]);
    await finish(2);
    expect(await again).toBe('page 2');
  });

  it('destroy cancels what is waiting and refuses anything new', async () => {
    const { extractor, finish } = gated();
    void extractor.load(1);
    const waiting = extractor.load(2);
    extractor.destroy();
    await expect(waiting).rejects.toBeInstanceOf(PageCancelledError);
    await expect(extractor.load(3)).rejects.toBeInstanceOf(PageCancelledError);
    await finish(1);
  });

  it('nobody has to handle the rejection of a page they no longer care about', async () => {
    const { extractor } = gated();
    void extractor.load(1);
    void extractor.load(2); // never awaited, never caught
    extractor.cancelPending();
    await new Promise((resolve) => setTimeout(resolve, 5)); // an unhandled rejection would fail the run
  });
});

describe('PdfPageExtractor - failures', () => {
  it('a page that fails rejects its own request and the next page still runs', async () => {
    const { extractor, started, finish, fail } = gated();
    const bad = extractor.load(1);
    const good = extractor.load(2);
    fail(1, new Error('boom'));
    await expect(bad).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
    await finish(2);
    expect(await good).toBe('page 2');
  });

  it('a job that throws as soon as it is called is reported as a failure, not left hanging', async () => {
    const extractor = new PdfPageExtractor<string>(() => {
      throw new Error('sync boom');
    });
    await expect(extractor.load(0)).rejects.toThrow('sync boom');
    await expect(extractor.load(1)).rejects.toThrow('sync boom');
  });
});
