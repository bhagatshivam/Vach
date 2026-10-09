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
vi.mock('pdfjs-dist', async (importOriginal) => {
  class FakePasswordException extends Error {
    code: number;
    constructor(message: string, code: number) {
      super(message);
      this.name = 'PasswordException';
      this.code = code;
    }
  }
  // OPS is a plain object of numeric constants (no worker/network
  // involvement) - real, not faked, so pdf.ts's module-level
  // IMAGE_PAINT_OPS/OTHER_PAINT_OPS sets (built from it at import time)
  // still get real values instead of undefined.
  const actual = await importOriginal<typeof import('pdfjs-dist')>();
  return {
    OPS: actual.OPS,
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.reject(new FakePasswordException('No password given', 1)),
    }),
  };
});

vi.mock('./pdfWorkerEntry.ts?url', () => ({ default: 'fake-worker-url' }));

const { openPdf } = await import('./pdf');

describe('openPdf - password-protected PDF', () => {
  it('turns a PasswordException into a clean, user-facing message instead of the raw technical error', async () => {
    await expect(openPdf('ZmFrZQ==', 'test.pdf')).rejects.toThrow("This PDF is password-protected and can't be opened");
  });
});
