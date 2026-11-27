// Runs per-page work (extracting one PDF page's text) one job at a time, in the order the reader needs the pages: pages the
// reader is about to see go first, pages nobody wants any more are dropped before they start, and asking for the same page
// twice shares one job. Pure scheduling - it knows nothing about pdf.js.
//
// Why a queue at all: pdf.js does its work in one worker, so extracting pages in parallel gains nothing, and extracting a
// page nobody will see (the reader jumped away while it waited) is work taken from the page they do want.

export class PageCancelledError extends Error {
  readonly pageIndex: number;
  constructor(pageIndex: number) {
    super(`Page ${pageIndex + 1} was not needed any more`);
    this.name = 'PageCancelledError';
    this.pageIndex = pageIndex;
  }
}

interface Job<T> {
  index: number;
  priority: number;
  /** Arrival order, so equal priorities run first come first served. */
  order: number;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  started: boolean;
}

export class PdfPageExtractor<T> {
  private readonly run: (pageIndex: number) => Promise<T>;
  private readonly concurrency: number;
  private readonly jobs = new Map<number, Job<T>>();
  private running = 0;
  private counter = 0;
  private destroyed = false;

  constructor(run: (pageIndex: number) => Promise<T>, concurrency = 1) {
    this.run = run;
    this.concurrency = Math.max(1, concurrency);
  }

  /**
   * The result for page `pageIndex` (0-based). A page that is already queued or running is not queued again (it may be
   * moved up if this request is more urgent). A higher `priority` runs sooner.
   */
  load(pageIndex: number, priority = 0): Promise<T> {
    if (this.destroyed) return Promise.reject(new PageCancelledError(pageIndex));
    const known = this.jobs.get(pageIndex);
    if (known) {
      if (!known.started && priority > known.priority) known.priority = priority;
      return known.promise;
    }
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A caller that was cancelled and does not care must not cause an unhandled rejection.
    promise.catch(() => {});
    this.jobs.set(pageIndex, { index: pageIndex, priority, order: this.counter++, promise, resolve, reject, started: false });
    this.pump();
    return promise;
  }

  /** Drops every job that has not started (their promises reject with PageCancelledError); a running one finishes. Returns how many were dropped. */
  cancelPending(): number {
    let dropped = 0;
    for (const [index, job] of this.jobs) {
      if (job.started) continue;
      this.jobs.delete(index);
      job.reject(new PageCancelledError(index));
      dropped++;
    }
    return dropped;
  }

  /** Cancels the queued pages and refuses new ones. */
  destroy(): void {
    this.destroyed = true;
    this.cancelPending();
  }

  /** How many pages are waiting or running (for tests and diagnostics). */
  get size(): number {
    return this.jobs.size;
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      let next: Job<T> | null = null;
      for (const job of this.jobs.values()) {
        if (job.started) continue;
        if (!next || job.priority > next.priority || (job.priority === next.priority && job.order < next.order)) next = job;
      }
      if (!next) return;
      this.start(next);
    }
  }

  private start(job: Job<T>): void {
    job.started = true;
    this.running++;
    let work: Promise<T>;
    try {
      work = this.run(job.index);
    } catch (error) {
      work = Promise.reject(error);
    }
    work.then(job.resolve, job.reject).finally(() => {
      this.running--;
      // Only forget the job if it is still this one (cancelPending never removes a started job, so it always is).
      if (this.jobs.get(job.index) === job) this.jobs.delete(job.index);
      this.pump();
    });
  }
}
