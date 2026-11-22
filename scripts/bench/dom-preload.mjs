// Preloaded with `node --import` before the benchmark bundle: epub.ts and
// DOMPurify need a DOM (window, document, DOMParser) at import time, and Node
// has none. (It cannot be an import inside the bundle: bundled output hoists
// its external imports, DOMPurify among them, above any inlined setup code.)
//
// jsdom is slower than a real browser's DOM, so absolute timings here are
// inflated - only before/after ratios mean anything.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = false;
