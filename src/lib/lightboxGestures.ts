// The maths behind the lightbox's touch gestures, kept free of the DOM so it
// can be tested with plain numbers. The picture (or table) is one box, `content`
// px at scale 1, drawn with `transform: translate(x, y) scale(s)` from its
// top-left corner inside a `viewport` box. Every function returns a new View
// that is already clamped, so a gesture can never push the content off the
// screen or leave a gap that wasn't there.

export interface Size {
  width: number;
  height: number;
}

/** Where the content is: scale, and the translation of its top-left corner (CSS px). */
export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface Bounds {
  viewport: Size;
  /** The content at scale 1. */
  content: Size;
}

export interface Limits {
  min: number;
  max: number;
  /** The scale it opens at (and returns to on a second double-tap). */
  initial: number;
}

export interface Point {
  x: number;
  y: number;
}

/** How far content may be zoomed beyond its opening size, at most. */
export const MAX_ZOOM_FACTOR = 6;
/** A double-tap zooms in to this many times the opening size. */
export const DOUBLE_TAP_ZOOM = 2.5;

/** The largest scale at which the whole content still fits the viewport. */
export function fitScale({ viewport, content }: Bounds): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  return Math.min(viewport.width / content.width, viewport.height / content.height);
}

/**
 * Zoom limits. A picture opens fitted to the screen. A table (`opensAtNaturalSize`)
 * opens at its own size, which is the readable one even when it is wider than
 * the screen (then it is panned); either way a pinch out can go as far as fitting
 * the whole thing.
 */
export function limitsFor(bounds: Bounds, opensAtNaturalSize = false): Limits {
  const fit = fitScale(bounds);
  const initial = opensAtNaturalSize ? 1 : fit;
  return { min: Math.min(fit, initial), max: Math.max(initial * MAX_ZOOM_FACTOR, 3), initial };
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/**
 * Keeps the content on screen: on an axis where it is smaller than the viewport
 * it is centred; where it is larger it may be panned until its edge meets the
 * viewport's, no further.
 */
export function clampView(view: View, { viewport, content }: Bounds, limits: Limits): View {
  const scale = clamp(view.scale, limits.min, limits.max);
  const width = content.width * scale;
  const height = content.height * scale;
  return {
    scale,
    x: width <= viewport.width ? (viewport.width - width) / 2 : clamp(view.x, viewport.width - width, 0),
    y: height <= viewport.height ? (viewport.height - height) / 2 : clamp(view.y, viewport.height - height, 0),
  };
}

/** The view a lightbox opens with: at the initial scale, centred (or top-left where larger than the screen). */
export function initialView(bounds: Bounds, limits: Limits): View {
  return clampView({ scale: limits.initial, x: 0, y: 0 }, bounds, limits);
}

/** Zooms to `scale` keeping the content point under (px, py) exactly where it was on screen. */
export function zoomAbout(view: View, scale: number, px: number, py: number, bounds: Bounds, limits: Limits): View {
  const next = clamp(scale, limits.min, limits.max);
  const ratio = next / view.scale;
  return clampView({ scale: next, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio }, bounds, limits);
}

export function pan(view: View, dx: number, dy: number, bounds: Bounds, limits: Limits): View {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, bounds, limits);
}

/**
 * Two fingers: the content point that was under the midpoint of the fingers at
 * the start stays under their midpoint now, and the scale follows how much the
 * distance between them grew or shrank.
 */
export function pinch(start: { view: View; a: Point; b: Point }, now: { a: Point; b: Point }, bounds: Bounds, limits: Limits): View {
  const startDistance = Math.hypot(start.b.x - start.a.x, start.b.y - start.a.y);
  const distance = Math.hypot(now.b.x - now.a.x, now.b.y - now.a.y);
  if (startDistance < 1) return clampView(start.view, bounds, limits);

  const scale = clamp(start.view.scale * (distance / startDistance), limits.min, limits.max);
  const startMid = { x: (start.a.x + start.b.x) / 2, y: (start.a.y + start.b.y) / 2 };
  const mid = { x: (now.a.x + now.b.x) / 2, y: (now.a.y + now.b.y) / 2 };
  // The content point under the start midpoint, then placed under the new midpoint at the new scale.
  const contentX = (startMid.x - start.view.x) / start.view.scale;
  const contentY = (startMid.y - start.view.y) / start.view.scale;
  return clampView({ scale, x: mid.x - contentX * scale, y: mid.y - contentY * scale }, bounds, limits);
}

/** Double-tap: zoomed out (at the opening size) -> zoom in about the tap; zoomed in -> back to the opening view. */
export function toggleZoom(view: View, px: number, py: number, bounds: Bounds, limits: Limits): View {
  const atOpening = view.scale <= limits.initial * 1.05;
  if (!atOpening) return initialView(bounds, limits);
  return zoomAbout(view, Math.max(limits.initial * DOUBLE_TAP_ZOOM, Math.min(1, limits.max)), px, py, bounds, limits);
}

// ---------------------------------------------------------------------------
// Taps and swipes
// ---------------------------------------------------------------------------

/** A pointer that barely moved, quickly, is a tap rather than a drag. */
export const TAP_MAX_MOVE_PX = 10;
export const TAP_MAX_MS = 300;
/** Two taps this close in time and place are a double-tap. */
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_DISTANCE_PX = 40;

export function isTap(movedPx: number, elapsedMs: number): boolean {
  return movedPx <= TAP_MAX_MOVE_PX && elapsedMs <= TAP_MAX_MS;
}

export function isDoubleTap(previous: { time: number; x: number; y: number } | null, tap: { time: number; x: number; y: number }): boolean {
  return previous !== null && tap.time - previous.time <= DOUBLE_TAP_MS && Math.hypot(tap.x - previous.x, tap.y - previous.y) <= DOUBLE_TAP_DISTANCE_PX;
}

/** A downward drag long enough (or fast enough) to dismiss: only at the opening size, never while zoomed in. */
export const DISMISS_DISTANCE_PX = 110;
export const DISMISS_FAST_DISTANCE_PX = 40;
export const DISMISS_VELOCITY_PX_PER_MS = 0.6;

export function shouldDismiss(dy: number, velocityPxPerMs: number, view: View, limits: Limits): boolean {
  if (view.scale > limits.initial * 1.05) return false;
  return dy >= DISMISS_DISTANCE_PX || (dy >= DISMISS_FAST_DISTANCE_PX && velocityPxPerMs >= DISMISS_VELOCITY_PX_PER_MS);
}

/** How far the backdrop has faded for a swipe of `dy` (0 = untouched, 1 = most of the way transparent). */
export function dismissProgress(dy: number, viewportHeight: number): number {
  return clamp(Math.max(0, dy) / Math.max(1, viewportHeight * 0.5), 0, 1);
}
