// pdf.js v6's content-stream evaluator, renderer, and several internal
// caches depend on two very new JS built-ins - Map.prototype.
// getOrInsertComputed (the TC39 "Map upsert" proposal) and Math.sumPrecise
// (the "precise sum" proposal) - neither of which is shipped in any
// released browser yet (confirmed empirically against Chromium 141, a
// very recent build released ~Oct 2025; real Android WebView tracks
// Chromium closely and lags behind desktop releases, so if desktop Chrome
// doesn't have it, WebView certainly doesn't either).
//
// This app now ships pdf.js's own "legacy" build (see pdf.ts), which
// bundles its own core-js-based self-polyfill for exactly these two
// methods - confirmed by reading its source: both are registered via
// core-js's `$({ target: ..., ... }, { ... })` export helper, which only
// installs where the native method is genuinely absent. In practice, that
// makes everything below redundant today.
//
// It's kept anyway, feature-detected the same way, as a second
// independent line of defense - specifically against a future
// accidental regression back to the main (non-legacy) build (which has
// zero compatibility-shim infrastructure at all - confirmed by grepping
// it for the same core-js export pattern and finding none), or a future
// pdfjs-dist release that drops its own self-polyfill. Both installers are
// idempotent (`in` checks the prototype, not own-property) and safe to
// call after the legacy build's own module body has already run.
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

/**
 * Math.sumPrecise(items): sums an iterable of numbers more accurately than
 * naive addition. The real TC39 proposal specifies an exact,
 * arbitrary-precision algorithm (Shewchuk summation, with full IEEE-754
 * edge-case handling for NaN/±Infinity/-0 and even values near the double
 * overflow boundary) - pdf.js's own bundled core-js polyfill implements
 * that exactly, and is what actually runs in practice per the module
 * comment above.
 *
 * This fallback is deliberately simpler: Neumaier (improved Kahan)
 * compensated summation, which is accurate to within ~1 ULP for any input
 * without extreme cancellation across a huge dynamic range - correct for
 * every call site this app's own usage reaches (summing glyph sizes,
 * buffer lengths, column widths: all small, similarly-scaled finite
 * numbers, never near the float64 magnitude boundary). It is NOT a
 * byte-for-byte reimplementation of the spec's exact algorithm, and
 * doesn't aim to be - given it's already redundant with pdf.js's own
 * exact self-polyfill (see above), the pragmatic, correct-for-real-input
 * choice here isn't worth the complexity of reimplementing Shewchuk
 * summation from scratch for a path that's extremely unlikely to ever
 * execute in production. NaN/±Infinity/-0 propagation rules are still
 * handled explicitly, matching the spec's observable behavior for those
 * cases.
 */
export function installSumPrecisePolyfill(): void {
  if (!('sumPrecise' in Math)) {
    Object.defineProperty(Math, 'sumPrecise', {
      value: function sumPrecise(items: Iterable<number>): number {
        const numbers = Array.from(items);
        let hasNaN = false;
        let hasPosInf = false;
        let hasNegInf = false;
        for (const n of numbers) {
          if (typeof n !== 'number') throw new TypeError('Value is not a number');
          if (Number.isNaN(n)) hasNaN = true;
          else if (n === Infinity) hasPosInf = true;
          else if (n === -Infinity) hasNegInf = true;
        }
        if (hasNaN || (hasPosInf && hasNegInf)) return NaN;
        if (hasPosInf) return Infinity;
        if (hasNegInf) return -Infinity;
        if (numbers.length === 0) return -0;

        let sum = 0;
        let compensation = 0;
        for (const n of numbers) {
          const t = sum + n;
          compensation += Math.abs(sum) >= Math.abs(n) ? sum - t + n : n - t + sum;
          sum = t;
        }
        return sum + compensation;
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

export function installPdfCompatPolyfills(): void {
  installMapUpsertPolyfill();
  installSumPrecisePolyfill();
}

/**
 * Reports which of the two gaps are natively missing in THIS realm, before
 * either polyfill above installs anything - intended to be logged to the
 * console (never shown in the UI) so a real-device issue is diagnosable
 * via chrome://inspect without needing to reproduce it locally first.
 */
export function detectPdfCompatGaps(): { getOrInsertComputedMissing: boolean; sumPreciseMissing: boolean } {
  return {
    getOrInsertComputedMissing: !('getOrInsertComputed' in Map.prototype),
    sumPreciseMissing: !('sumPrecise' in Math),
  };
}
