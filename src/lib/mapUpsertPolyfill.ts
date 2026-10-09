// pdf.js v6's content-stream evaluator, renderer, and several internal
// caches depend pervasively on Map.prototype.getOrInsertComputed (the TC39
// "Map upsert" proposal) - confirmed empirically against Chromium 141 (a
// very recent build, released ~Oct 2025) that it isn't shipped in any
// released browser yet, including real Android WebView (which tracks
// Chromium closely and lags behind desktop releases, so if desktop Chrome
// doesn't have it, WebView certainly doesn't either). Without this,
// page.getOperatorList() and page.render() throw "getOrInsertComputed is
// not a function" on every single call, in real production Chromium - not
// just this sandbox - which would silently break the entire textless-page
// classification and rasterization feature on every real device.
//
// This is a small, precisely-specified method (see the proposal:
// https://github.com/tc39/proposal-upsert) - safe to polyfill locally
// rather than waiting on browser support, same "small, local, no network"
// spirit as every other dependency in this offline app.
export function installMapUpsertPolyfill(): void {
  if (!('getOrInsertComputed' in Map.prototype)) {
    Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
      value: function getOrInsertComputed(this: Map<unknown, unknown>, key: unknown, callbackfn: (key: unknown) => unknown) {
        if (this.has(key)) return this.get(key);
        const value = callbackfn(key);
        this.set(key, value);
        return value;
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
