import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { convertDocxBytes } from './docxClient';
import { DocxError } from './docxError';
import type { DocxConversion } from './docxTypes';

// How a document is handed to the converter: in a Worker when there is one, on the main thread when not (or when the
// Worker cannot start), with the document's own errors passed through intact either way.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sample = () => {
  const bytes = readFileSync('samples/docx-sample.docx');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
const result: DocxConversion = { html: '<p>from the worker</p>', images: [], title: 'W', warnings: [] };

class FakeWorker {
  static instances: FakeWorker[] = [];
  static behaviour: (worker: FakeWorker, message: { buffer: ArrayBuffer }) => void = () => {};
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  posted: unknown[] = [];
  url: URL;
  options?: WorkerOptions;
  constructor(url: URL, options?: WorkerOptions) {
    this.url = url;
    this.options = options;
    FakeWorker.instances.push(this);
  }
  postMessage(message: { buffer: ArrayBuffer }) {
    this.posted.push(message);
    queueMicrotask(() => FakeWorker.behaviour(this, message));
  }
  terminate() {
    this.terminated = true;
  }
}

describe('convertDocxBytes', () => {
  it('with no Worker available, converts on the main thread (real mammoth)', async () => {
    vi.stubGlobal('Worker', undefined);
    const converted = await convertDocxBytes(sample());
    expect(converted.title).toBe('Vach DOCX Sample');
    expect(converted.html).toContain('<h1>Part One: Headings and text</h1>');
  });

  it('a bad file gives the same DocxError on the main thread', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(convertDocxBytes(new TextEncoder().encode('not a document at all').buffer as ArrayBuffer)).rejects.toMatchObject({ name: 'DocxError', code: 'not-docx' });
  });

  it('uses a module Worker when there is one, sends a copy (not the original), and ends it afterwards', async () => {
    FakeWorker.instances = [];
    FakeWorker.behaviour = (worker) => worker.onmessage!({ data: { id: 1, ok: true, result } } as MessageEvent);
    vi.stubGlobal('Worker', FakeWorker);
    const buffer = sample();
    const converted = await convertDocxBytes(buffer);
    expect(converted).toBe(result);
    const [worker] = FakeWorker.instances;
    expect(worker.options).toEqual({ type: 'module' });
    expect(String(worker.url)).toMatch(/docxWorker/);
    expect(worker.terminated).toBe(true);
    expect((worker.posted[0] as { buffer: ArrayBuffer }).buffer).toBe(buffer);
    expect(buffer.byteLength).toBeGreaterThan(0); // not transferred: still ours
  });

  it("a document's error from the Worker is rebuilt as a DocxError, without trying the main thread", async () => {
    FakeWorker.instances = [];
    FakeWorker.behaviour = (worker) => worker.onmessage!({ data: { id: 1, ok: false, code: 'password-protected', message: 'locked' } } as MessageEvent);
    vi.stubGlobal('Worker', FakeWorker);
    const error = await convertDocxBytes(sample()).catch((e) => e);
    expect(error).toBeInstanceOf(DocxError);
    expect(error.code).toBe('password-protected');
    expect(error.message).toBe('locked');
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('a Worker that cannot start falls back to the main thread, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    FakeWorker.instances = [];
    FakeWorker.behaviour = (worker) => worker.onerror!({ message: 'blocked' } as ErrorEvent);
    vi.stubGlobal('Worker', FakeWorker);
    const converted = await convertDocxBytes(sample());
    expect(converted.title).toBe('Vach DOCX Sample');
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a Worker constructor that throws also falls back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('Worker', class { constructor() { throw new Error('worker-src blocks this'); } });
    expect((await convertDocxBytes(sample())).title).toBe('Vach DOCX Sample');
  });

  it('aborting ends the Worker and rejects with an AbortError', async () => {
    FakeWorker.instances = [];
    FakeWorker.behaviour = () => {}; // never answers
    vi.stubGlobal('Worker', FakeWorker);
    const controller = new AbortController();
    const pending = convertDocxBytes(sample(), controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });
});
