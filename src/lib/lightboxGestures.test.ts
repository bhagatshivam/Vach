import { describe, expect, it } from 'vitest';
import {
  DISMISS_DISTANCE_PX,
  DOUBLE_TAP_MS,
  clampView,
  dismissProgress,
  fitScale,
  initialView,
  isDoubleTap,
  isTap,
  limitsFor,
  pan,
  pinch,
  shouldDismiss,
  toggleZoom,
  zoomAbout,
  type Bounds,
  type View,
} from './lightboxGestures';

// A 400x800 viewport (a phone) and a 4000x6000 picture.
const phone = { width: 400, height: 800 };
const picture: Bounds = { viewport: phone, content: { width: 4000, height: 6000 } };
const pictureLimits = limitsFor(picture);

describe('fit and limits', () => {
  it('fits the whole picture inside the viewport', () => {
    expect(fitScale(picture)).toBeCloseTo(Math.min(400 / 4000, 800 / 6000), 6); // 0.1
    const small: Bounds = { viewport: phone, content: { width: 100, height: 100 } };
    expect(fitScale(small)).toBe(4); // a small picture is enlarged to fit (the box is what is shown)
  });

  it('a picture opens fitted, can zoom in about 6x past that, and never out past the fit', () => {
    expect(pictureLimits.initial).toBeCloseTo(0.1, 6);
    expect(pictureLimits.min).toBeCloseTo(0.1, 6);
    expect(pictureLimits.max).toBeGreaterThanOrEqual(3);
    expect(pictureLimits.max).toBeCloseTo(Math.max(0.1 * 6, 3), 6);
  });

  it('a table opens at its own size (1), may pinch out to fit, and may zoom in', () => {
    const table: Bounds = { viewport: phone, content: { width: 1600, height: 500 } };
    const limits = limitsFor(table, true);
    expect(limits.initial).toBe(1);
    expect(limits.min).toBeCloseTo(0.25, 6);
    expect(limits.max).toBeGreaterThan(1);
  });

  it('a degenerate (zero-size) content does not produce NaN', () => {
    expect(fitScale({ viewport: phone, content: { width: 0, height: 0 } })).toBe(1);
  });
});

describe('clampView - the content never leaves the screen', () => {
  it('centres the content on an axis where it is smaller than the viewport', () => {
    const view = initialView(picture, pictureLimits); // 400 x 600 inside 400 x 800
    expect(view.scale).toBeCloseTo(0.1, 6);
    expect(view.x).toBeCloseTo(0, 6);
    expect(view.y).toBeCloseTo(100, 6);
  });

  it('stops panning when an edge meets the viewport edge, on every side', () => {
    const zoomed: View = { scale: 0.4, x: 0, y: 0 }; // 1600 x 2400
    const topLeft = clampView({ ...zoomed, x: 500, y: 500 }, picture, pictureLimits);
    expect(topLeft.x).toBe(0);
    expect(topLeft.y).toBe(0);
    const bottomRight = clampView({ ...zoomed, x: -99999, y: -99999 }, picture, pictureLimits);
    expect(bottomRight.x).toBe(400 - 1600);
    expect(bottomRight.y).toBe(800 - 2400);
  });

  it('clamps the scale into the limits', () => {
    expect(clampView({ scale: 100, x: 0, y: 0 }, picture, pictureLimits).scale).toBe(pictureLimits.max);
    expect(clampView({ scale: 0.0001, x: 0, y: 0 }, picture, pictureLimits).scale).toBe(pictureLimits.min);
  });

  it('pan is clamped too', () => {
    const view: View = { scale: 0.4, x: -100, y: -100 };
    const moved = pan(view, 10_000, 10_000, picture, pictureLimits);
    expect(moved.x).toBe(0);
    expect(moved.y).toBe(0);
    const back = pan(view, -10_000, -10_000, picture, pictureLimits);
    expect(back.x).toBe(400 - 1600);
    expect(back.y).toBe(800 - 2400);
  });
});

describe('zoomAbout - the point under the finger stays under the finger', () => {
  it('keeps a content point fixed on screen while zooming', () => {
    const start: View = { scale: 0.2, x: -100, y: -300 }; // 800 x 1200: bigger than the viewport on both axes
    const px = 200;
    const py = 400;
    const contentPoint = { x: (px - start.x) / start.scale, y: (py - start.y) / start.scale };
    const next = zoomAbout(start, 0.5, px, py, picture, pictureLimits);
    expect((contentPoint.x * next.scale + next.x)).toBeCloseTo(px, 4);
    expect((contentPoint.y * next.scale + next.y)).toBeCloseTo(py, 4);
  });

  it('is clamped: zooming about a corner cannot reveal empty space', () => {
    const start = initialView(picture, pictureLimits);
    const next = zoomAbout(start, 0.6, 0, 0, picture, pictureLimits);
    expect(next.x).toBeLessThanOrEqual(0);
    expect(next.y).toBeLessThanOrEqual(0);
    expect(next.x).toBeGreaterThanOrEqual(400 - 4000 * 0.6);
  });
});

describe('pinch', () => {
  const start: View = { scale: 0.2, x: -100, y: -200 };
  const a = { x: 150, y: 400 };
  const b = { x: 250, y: 400 };

  it('spreading the fingers zooms in, by the ratio of the distances', () => {
    const next = pinch({ view: start, a, b }, { a: { x: 100, y: 400 }, b: { x: 300, y: 400 } }, picture, pictureLimits);
    expect(next.scale).toBeCloseTo(0.4, 6); // distance 100 -> 200
  });

  it('pinching in zooms out, never below the fit', () => {
    const next = pinch({ view: start, a, b }, { a: { x: 199, y: 400 }, b: { x: 201, y: 400 } }, picture, pictureLimits);
    expect(next.scale).toBe(pictureLimits.min);
  });

  it('keeps the content point under the fingers\' midpoint under it, even when the midpoint moves (pinch + pan together)', () => {
    const startMid = { x: 200, y: 400 };
    const contentPoint = { x: (startMid.x - start.x) / start.scale, y: (startMid.y - start.y) / start.scale };
    const nowA = { x: 130, y: 450 };
    const nowB = { x: 330, y: 450 }; // twice as far apart, midpoint moved down 50 and right 30
    const next = pinch({ view: start, a, b }, { a: nowA, b: nowB }, picture, pictureLimits);
    const mid = { x: 230, y: 450 };
    expect(contentPoint.x * next.scale + next.x).toBeCloseTo(mid.x, 3);
    expect(contentPoint.y * next.scale + next.y).toBeCloseTo(mid.y, 3);
  });

  it('is clamped to the screen', () => {
    const next = pinch({ view: start, a, b }, { a: { x: -9000, y: 0 }, b: { x: 9000, y: 0 } }, picture, pictureLimits);
    expect(next.scale).toBe(pictureLimits.max);
    expect(next.x).toBeLessThanOrEqual(0);
    expect(next.x).toBeGreaterThanOrEqual(400 - 4000 * pictureLimits.max);
  });

  it('two fingers on the same spot does not blow up', () => {
    const view = pinch({ view: start, a, b: a }, { a, b }, picture, pictureLimits);
    expect(Number.isFinite(view.scale)).toBe(true);
  });
});

describe('double-tap', () => {
  it('zooms in about the tapped point from the opening size, and back out the next time', () => {
    const opening = initialView(picture, pictureLimits);
    const zoomed = toggleZoom(opening, 300, 300, picture, pictureLimits);
    expect(zoomed.scale).toBeGreaterThan(opening.scale * 2);
    const back = toggleZoom(zoomed, 300, 300, picture, pictureLimits);
    expect(back).toEqual(opening);
  });

  it('is a double-tap only if the two taps are close in time AND place', () => {
    const first = { time: 1000, x: 100, y: 100 };
    expect(isDoubleTap(first, { time: 1000 + DOUBLE_TAP_MS, x: 110, y: 105 })).toBe(true);
    expect(isDoubleTap(first, { time: 1000 + DOUBLE_TAP_MS + 1, x: 110, y: 105 })).toBe(false);
    expect(isDoubleTap(first, { time: 1100, x: 300, y: 100 })).toBe(false);
    expect(isDoubleTap(null, { time: 1100, x: 100, y: 100 })).toBe(false);
  });

  it('a tap barely moves and is quick', () => {
    expect(isTap(3, 120)).toBe(true);
    expect(isTap(30, 120)).toBe(false);
    expect(isTap(3, 900)).toBe(false);
  });
});

describe('swipe down to dismiss', () => {
  const opening = initialView(picture, pictureLimits);
  const zoomedIn = zoomAbout(opening, 0.6, 200, 400, picture, pictureLimits);

  it('dismisses on a long drag, or a short fast flick', () => {
    expect(shouldDismiss(DISMISS_DISTANCE_PX, 0, opening, pictureLimits)).toBe(true);
    expect(shouldDismiss(DISMISS_DISTANCE_PX - 1, 0, opening, pictureLimits)).toBe(false);
    expect(shouldDismiss(50, 0.9, opening, pictureLimits)).toBe(true);
    expect(shouldDismiss(30, 0.9, opening, pictureLimits)).toBe(false);
  });

  it('never dismisses while zoomed in (a drag then pans instead), and never upward', () => {
    expect(shouldDismiss(500, 2, zoomedIn, pictureLimits)).toBe(false);
    expect(shouldDismiss(-500, 2, opening, pictureLimits)).toBe(false);
  });

  it('fades the backdrop with the drag and stays within 0..1', () => {
    expect(dismissProgress(0, 800)).toBe(0);
    expect(dismissProgress(-50, 800)).toBe(0);
    expect(dismissProgress(200, 800)).toBeCloseTo(0.5, 6);
    expect(dismissProgress(5000, 800)).toBe(1);
  });
});
