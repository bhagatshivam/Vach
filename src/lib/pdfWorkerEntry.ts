// pdf.js runs its real parsing/rendering work inside a dedicated Worker
// thread, a completely separate JS realm from the main thread - its own
// Map/Math built-ins, unaffected by anything patched on the main thread's.
// This file is what actually becomes the Worker's entry script (see the
// `?worker&url` import in pdf.ts), so this app's own (redundant, defensive
// - see pdfCompatPolyfills.ts) polyfills have to be installed HERE, in this
// realm, before pdf.worker.mjs's own module body runs - not just once on
// the main thread.
//
// A static `import` would be hoisted ahead of this code (ES module import
// declarations execute before the importing module's own top-level code,
// regardless of where they're textually written); a dynamic import() runs
// exactly where it appears, which is what guarantees ordering here.
//
// Imports the LEGACY worker build specifically - it must match the main
// thread's legacy API build (pdf.js throws a version-mismatch error
// otherwise) and is what actually resolves both compatibility gaps via its
// own bundled core-js self-polyfill (see pdf.ts's own top-of-file comment).
import { detectPdfCompatGaps, installPdfCompatPolyfills } from './pdfCompatPolyfills';

const gaps = detectPdfCompatGaps();
if (gaps.getOrInsertComputedMissing || gaps.sumPreciseMissing) {
  console.log(
    '[pdf worker] compat check - natively missing:',
    [gaps.getOrInsertComputedMissing && 'Map.prototype.getOrInsertComputed', gaps.sumPreciseMissing && 'Math.sumPrecise']
      .filter(Boolean)
      .join(', '),
    '| userAgent:',
    navigator.userAgent,
  );
}

installPdfCompatPolyfills();

await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
