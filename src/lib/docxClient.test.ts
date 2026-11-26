import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { convertDocxBytes } from './docxClient';
import { DocxError } from './docxError';
import type { DocxConversion } from './docxTypes';

// How a document is handed to the converter: always in a Worker, with the document's own errors passed through intact,
// and a plain message (not a crash) if no Worker can run.

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
  it('with no Worker available the document cannot be opened, and the message says so', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(convertDocxBytes(sample())).rejects.toMatchObject({ name: 'DocxError', code: 'unreadable' });
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

  it('a Worker that cannot start, or stops before answering, is a plain DocxError and the Worker is ended', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    FakeWorker.instances = [];
    FakeWorker.behaviour = (worker) => worker.onerror!({ message: 'blocked' } as ErrorEvent);
    vi.stubGlobal('Worker', FakeWorker);
    await expect(convertDocxBytes(sample())).rejects.toMatchObject({ name: 'DocxError', code: 'unreadable' });
    expect(FakeWorker.instances[0].terminated).toBe(true);

    vi.stubGlobal('Worker', class { constructor() { throw new Error('worker-src blocks this'); } });
    await expect(convertDocxBytes(sample())).rejects.toMatchObject({ name: 'DocxError', code: 'unreadable' });
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
