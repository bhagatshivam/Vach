// The Worker entry: converts one document per message and posts the result back. The bytes of the pictures are
// transferred, not copied. Errors cross the thread boundary as a code plus message and are rebuilt by docxClient.ts.
import { convertDocx } from './docxConvert';
import type { DocxConversion } from './docxTypes';
import { DocxError, type DocxErrorCode } from './docxError';

export type DocxWorkerRequest = { id: number; buffer: ArrayBuffer };
export type DocxWorkerReply = { id: number; ok: true; result: DocxConversion } | { id: number; ok: false; code: DocxErrorCode; message: string };

const scope = self as unknown as { onmessage: ((event: MessageEvent<DocxWorkerRequest>) => void) | null; postMessage(message: DocxWorkerReply, transfer?: Transferable[]): void };

scope.onmessage = async (event) => {
  const { id, buffer } = event.data;
  try {
    const result = await convertDocx(buffer);
    scope.postMessage({ id, ok: true, result }, result.images.map((image) => image.bytes.buffer as ArrayBuffer));
  } catch (err) {
    const error = err instanceof DocxError ? err : new DocxError('unreadable');
    scope.postMessage({ id, ok: false, code: error.code, message: error.message });
  }
};
