import { describe, expect, it, vi } from 'vitest';

// Mocked rather than exercised against a real encrypted PDF: pdf.js's own
// PDF 2.0/AES-256 (revision 6) key-derivation code calls Math.sumPrecise, a
// very new JS builtin (see the Phase C report) that isn't available in
// every environment that can run this test suite - a real encrypted PDF
// would fail with an unrelated "Math.sumPrecise is not a function" crash
// here, before ever reaching the PasswordException this test is actually
// about. Mocking getDocument() to reject the same way pdf.js does on an
// environment that *does* support it tests the one thing this file is
// responsible for: turning that specific rejection into a clean message.
vi.mock('pdfjs-dist', () => {
  class FakePasswordException extends Error {
    code: number;
    constructor(message: string, code: number) {
      super(message);
      this.name = 'PasswordException';
      this.code = code;
    }
  }
  return {
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.reject(new FakePasswordException('No password given', 1)),
    }),
  };
});

vi.mock('pdfjs-dist/build/pdf.worker.mjs?url', () => ({ default: 'fake-worker-url' }));

const { streamPdf } = await import('./pdf');

describe('streamPdf - password-protected PDF', () => {
  it('turns a PasswordException into a clean, user-facing message instead of the raw technical error', async () => {
    const generator = streamPdf('ZmFrZQ==', 'test.pdf');
    await expect(generator.next()).rejects.toThrow("This PDF is password-protected and can't be opened");
  });
});
