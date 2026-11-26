// Runs the Word converter off the main thread. A Worker keeps a big document from freezing the screen; if a Worker
// cannot be started (blocked, or an environment without one) the same converter runs on the main thread instead,
// loaded on demand. Either way mammoth is only fetched when a .docx is actually opened.
import type { DocxConversion } from './docxTypes';
import { DocxError } from './docxError';
import type { DocxWorkerReply } from './docxWorker';

export type DocxConverter = (buffer: ArrayBuffer, signal?: AbortSignal) => Promise<DocxConversion>;

async function convertOnMainThread(buffer: ArrayBuffer): Promise<DocxConversion> {
  const { convertDocx } = await import('./docxConvert');
  return convertDocx(buffer);
}

function convertInWorker(buffer: ArrayBuffer, signal?: AbortSignal): Promise<DocxConversion> {
  return new Promise<DocxConversion>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./docxWorker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      finish();
      reject(new DOMException('Opening was cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort);
    worker.onmessage = (event: MessageEvent<DocxWorkerReply>) => {
      const reply = event.data;
      finish();
      if (reply.ok) resolve(reply.result);
      else reject(new DocxError(reply.code, reply.message));
    };
    worker.onerror = (event) => {
      finish();
      reject(new WorkerUnavailable(event.message));
    };
    // Copied, not transferred: if the worker cannot start, the main thread still has the bytes to convert itself.
    worker.postMessage({ id: 1, buffer });
  });
}

/** The worker could not be started or crashed before replying (as opposed to the document being bad). */
class WorkerUnavailable extends Error {}

/** Converts in a Worker, falling back to the main thread if no Worker can run. */
export const convertDocxBytes: DocxConverter = async (buffer, signal) => {
  if (typeof Worker === 'undefined') return convertOnMainThread(buffer);
  try {
    return await convertInWorker(buffer, signal);
  } catch (err) {
    if (err instanceof DocxError || (err instanceof DOMException && err.name === 'AbortError')) throw err;
    console.warn('[docx] worker unavailable, converting on the main thread', err);
    return convertOnMainThread(buffer);
  }
};
