// pdf.js runs its real parsing/rendering work inside a dedicated Worker
// thread, a completely separate JS realm from the main thread - its own
// Map built-in, unaffected by anything patched on the main thread's Map.
// This file is what actually becomes the Worker's entry script (see the
// `?url` import in pdf.ts), so the polyfill has to be installed HERE, in
// this realm, before pdf.worker.mjs's own module body runs - not just once
// on the main thread.
//
// A static `import` would be hoisted ahead of the polyfill call (ES module
// import declarations execute before the importing module's own top-level
// code, regardless of where they're textually written); a dynamic
// import() runs exactly where it appears, which is what guarantees the
// polyfill is installed first.
import { installMapUpsertPolyfill } from './mapUpsertPolyfill';

installMapUpsertPolyfill();

await import('pdfjs-dist/build/pdf.worker.mjs');
