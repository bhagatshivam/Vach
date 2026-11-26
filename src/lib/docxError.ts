// What can go wrong opening a Word document, in words a reader can act on. Kept tiny and free of imports so the
// reader screen can recognise these errors without loading the converter.

export type DocxErrorCode = 'password-protected' | 'not-docx' | 'corrupt' | 'unreadable';

const MESSAGES: Record<DocxErrorCode, string> = {
  'password-protected': "This document is password-protected (or is an old .doc file), so it can't be opened.",
  'not-docx': "This file isn't a Word (.docx) document.",
  corrupt: 'This document looks damaged, so it could not be opened.',
  unreadable: "This document could not be read. It may use features that aren't supported.",
};

/** An error whose message is already a complete, user-facing sentence (like FileTooLargeError). */
export class DocxError extends Error {
  readonly code: DocxErrorCode;
  constructor(code: DocxErrorCode, message?: string) {
    super(message ?? MESSAGES[code]);
    this.name = 'DocxError';
    this.code = code;
  }
}

export function isDocxErrorCode(value: unknown): value is DocxErrorCode {
  return typeof value === 'string' && value in MESSAGES;
}
