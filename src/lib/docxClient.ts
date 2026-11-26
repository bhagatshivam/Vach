// Runs the Word converter off the main thread, in a Worker, so a big document never freezes the screen. Nothing else
// loads the converter (mammoth): it is fetched only when a .docx is opened. (There is no main-thread fallback: the
// same-origin module Worker this needs is exactly what pdf.js already needs to open a PDF on this app's WebView, and a
// second copy of the converter would cost the APK about 70 KB compressed.)
import type { DocxConversion } from './docxTypes';
import { DocxError } from './docxError';
import type { DocxWorkerReply } from './docxWorker';

export type DocxConverter = (buffer: ArrayBuffer, signal?: AbortSignal) => Promise<DocxConversion>;

function convertInWorker(buffer: ArrayBuffer, signal?: AbortSignal): Promise<DocxConversion> {
  if (typeof Worker === 'undefined') return Promise.reject(new DocxError('unreadable'));
  return new Promise<DocxConversion>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./docxWorker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      console.error('[docx] could not start the converter', err);
      reject(new DocxError('unreadable'));
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
      console.error('[docx] the converter stopped', event.message);
      finish();
      reject(new DocxError('unreadable'));
    };
    // Copied, not transferred: the reader keeps its bytes until the book is open (and drops them right after).
    worker.postMessage({ id: 1, buffer });
  });
}

/** Converts in a Worker. If none can run, the document cannot be opened, and the reader says so in words. */
export const convertDocxBytes: DocxConverter = (buffer, signal) => convertInWorker(buffer, signal);
