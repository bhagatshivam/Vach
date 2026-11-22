import { describe, expect, it, vi } from 'vitest';

// Mocked rather than exercised against a real encrypted PDF: a real
// getDocument() call under vitest/Node hits an unrelated gap - the fake
// worker Node's pdf.js fallback spins up needs Promise.try, which isn't
// available in every Node version that can run this suite (confirmed
// separately; irrelevant to production, since real Chromium has it) -
// before ever reaching the PasswordException this test is actually about.
// Real Chromium, including the specific Math.sumPrecise crash this file
// used to document, is now covered by the legacy pdfjs-dist build (see
// pdf.ts) plus this app's own redundant polyfill (pdfCompatPolyfills.ts),
// both verified directly against the real password-protected.pdf fixture
// in real Chromium with both polyfills disabled - see the Milestone 2
// verification report. Mocking getDocument() to reject the same way pdf.js
// does tests the one thing this file is responsible for: turning that
// rejection into a clean message.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', async (importOriginal) => {
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
  const actual = await importOriginal<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>();
  return {
    OPS: actual.OPS,
    // Real class: pdfRangeTransport.ts extends it at import time. It has no
    // worker/network involvement until a listener is attached, so using the
    // real one here is safe.
    PDFDataRangeTransport: actual.PDFDataRangeTransport,
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.reject(new FakePasswordException('No password given', 1)),
    }),
  };
});

vi.mock('./pdfWorkerEntry.ts?worker&url', () => ({ default: 'fake-worker-url' }));

const { openPdf } = await import('./pdf');

describe('openPdf - password-protected PDF', () => {
  it('turns a PasswordException into a clean, user-facing message instead of the raw technical error', async () => {
    const source = { size: 4, read: async (begin: number, end: number) => new Uint8Array(end - begin) };
    await expect(openPdf(source, 'test.pdf')).rejects.toThrow("This PDF is password-protected and can't be opened");
  });
});
