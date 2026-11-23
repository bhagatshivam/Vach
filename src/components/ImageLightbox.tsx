import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { FullImage } from '../lib/imageProcessor';
import {
  clampView,
  dismissProgress,
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
  type Limits,
  type Point,
  type View,
} from '../lib/lightboxGestures';

// One full-screen overlay for two things: a picture (tap one in the book) and a
// wide table (Expand Grid). Pure CSS + Pointer Events, no library:
//   pinch (two fingers) to zoom, drag to pan (clamped, never off the screen),
//   double-tap to zoom in and out, swipe down to close (at the opening size),
//   and the close button, Escape and the hardware Back button.
// The content is a single box moved by one transform, so the page underneath is
// untouched and nothing here re-renders while a finger moves.

export interface LightboxImage {
  /** What to show while the full-detail version loads (the picture as it is in the page); absent if not ready. */
  src?: string;
  /** The picture's size, which also fixes the size of the box being zoomed. */
  width: number;
  height: number;
  alt?: string;
}

interface ImageLightboxProps {
  onClose: () => void;
  /** Accessible name of the dialog. */
  label: string;
  /** A picture... */
  image?: LightboxImage;
  /**
   * Decodes the original at full detail (capped by the caller). Called once on
   * open; the result's release() is called on close, which frees the decoded copy.
   */
  loadFull?: () => Promise<FullImage | null>;
  /** ...or a DOM node, such as a cloned table (Expand Grid). */
  node?: HTMLElement;
  /** Styles for the sheet a node sits on, so it can follow the reader's theme. */
  contentStyle?: CSSProperties;
  /** Offer "Invert" - for dark-theme readers looking at white-background diagrams. */
  canInvert?: boolean;
}

const SETTLE_MS = 180;

export default function ImageLightbox({ onClose, label, image, loadFull, node, contentStyle, canInvert }: ImageLightboxProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const domRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const boundsRef = useRef<Bounds>({ viewport: { width: 1, height: 1 }, content: { width: 1, height: 1 } });
  const limitsRef = useRef<Limits>({ min: 1, max: 3, initial: 1 });
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [fullSrc, setFullSrc] = useState<string | null>(null);
  const [inverted, setInverted] = useState(false);

  const show = image ? (fullSrc ?? image.src) : undefined;

  // --- Writing the view -------------------------------------------------------
  const apply = useCallback((view: View, animate = false) => {
    viewRef.current = view;
    const content = contentRef.current;
    if (!content) return;
    if (animate) {
      content.classList.add('settling');
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => content.classList.remove('settling'), SETTLE_MS);
    }
    content.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }, []);

  // --- Measuring: the viewport, the content, the limits -----------------------
  // Depends on the picture's size, not on the `image` object, so a parent re-render
  // that builds an equal object does not reset the zoom.
  const hasImage = Boolean(image);
  const imageWidth = image?.width ?? 1;
  const imageHeight = image?.height ?? 1;
  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const viewport = { width: stage.clientWidth || 1, height: stage.clientHeight || 1 };
    let content = { width: imageWidth, height: imageHeight };
    if (!hasImage && domRef.current) content = { width: domRef.current.offsetWidth || 1, height: domRef.current.offsetHeight || 1 };

    boundsRef.current = { viewport, content };
    limitsRef.current = limitsFor(boundsRef.current, !hasImage); // a table opens at its own size, a picture fitted
    if (contentRef.current && !hasImage) {
      contentRef.current.style.width = `${content.width}px`;
      contentRef.current.style.height = `${content.height}px`;
    }
    apply(initialView(boundsRef.current, limitsRef.current));
  }, [apply, hasImage, imageWidth, imageHeight]);

  // A node (the cloned table) goes into the DOM, then everything is measured.
  useLayoutEffect(() => {
    const host = domRef.current;
    if (host && node) host.replaceChildren(node);
    measure();
    return () => host?.replaceChildren();
  }, [node, measure]);

  // Turning the phone: refit.
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  // --- Full-detail decode: asked for once on open, freed on close ---------------
  useEffect(() => {
    if (!loadFull) return;
    let cancelled = false;
    let full: FullImage | null = null;
    loadFull()
      .then((result) => {
        if (cancelled) result?.release();
        else if (result) {
          full = result;
          setFullSrc(result.url);
        }
      })
      .catch(() => {
        // The picture in the page stays on screen; nothing to report.
      });
    return () => {
      cancelled = true;
      full?.release();
    };
  }, [loadFull]);

  // --- Keys and wheel -----------------------------------------------------------
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // Native, not React's onWheel: it must be non-passive to stop the page scrolling behind.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0015);
      apply(zoomAbout(viewRef.current, viewRef.current.scale * factor, event.clientX - rect.left, event.clientY - rect.top, boundsRef.current, limitsRef.current));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [apply]);

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  // --- Pointer gestures -----------------------------------------------------------
  const pointers = useRef(new Map<number, Point>());
  const pinchStart = useRef<{ view: View; a: Point; b: Point } | null>(null);
  const drag = useRef<{
    startX: number;
    startY: number;
    startTime: number;
    lastX: number;
    lastY: number;
    lastTime: number;
    velocityY: number;
    mode: 'undecided' | 'pan' | 'dismiss';
    dismissDy: number;
    moved: number;
  } | null>(null);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);

  const local = (event: { clientX: number; clientY: number }): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  /** Can the content be moved (it is larger than the screen on some axis)? Otherwise a vertical drag dismisses. */
  const canPan = (): boolean => {
    const { viewport, content } = boundsRef.current;
    const { scale } = viewRef.current;
    return content.width * scale > viewport.width + 0.5 || content.height * scale > viewport.height + 0.5;
  };

  const beginDrag = (point: Point, time: number, mode: 'undecided' | 'pan') => {
    drag.current = { startX: point.x, startY: point.y, startTime: time, lastX: point.x, lastY: point.y, lastTime: time, velocityY: 0, mode, dismissDy: 0, moved: 0 };
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    try {
      stageRef.current?.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or already-released pointer: gestures still work without capture.
    }
    const point = local(event);
    pointers.current.set(event.pointerId, point);

    if (pointers.current.size === 1) {
      beginDrag(point, event.timeStamp, 'undecided');
    } else if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      pinchStart.current = { view: viewRef.current, a, b };
      drag.current = null;
      resetDismissVisuals(false);
    }
  };

  const resetDismissVisuals = (animate: boolean) => {
    if (backdropRef.current) backdropRef.current.style.opacity = '1';
    apply(viewRef.current, animate);
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = local(event);
    pointers.current.set(event.pointerId, point);

    if (pinchStart.current && pointers.current.size >= 2) {
      const [a, b] = Array.from(pointers.current.values());
      apply(pinch(pinchStart.current, { a, b }, boundsRef.current, limitsRef.current));
      return;
    }

    const d = drag.current;
    if (!d) return;
    const dx = point.x - d.lastX;
    const dy = point.y - d.lastY;
    const dt = Math.max(1, event.timeStamp - d.lastTime);
    d.velocityY = d.velocityY * 0.6 + (dy / dt) * 0.4;
    d.lastX = point.x;
    d.lastY = point.y;
    d.lastTime = event.timeStamp;
    d.moved = Math.max(d.moved, Math.hypot(point.x - d.startX, point.y - d.startY));

    if (d.mode === 'undecided' && d.moved > 8) {
      // Content larger than the screen: a drag moves it. Fitted: a downward drag dismisses, anything else is ignored.
      const vertical = Math.abs(point.y - d.startY) > Math.abs(point.x - d.startX);
      d.mode = canPan() ? 'pan' : vertical && point.y > d.startY ? 'dismiss' : 'undecided';
    }
    if (d.mode === 'pan') {
      apply(pan(viewRef.current, dx, dy, boundsRef.current, limitsRef.current));
    } else if (d.mode === 'dismiss') {
      d.dismissDy = Math.max(0, point.y - d.startY);
      const v = viewRef.current;
      if (contentRef.current) contentRef.current.style.transform = `translate(${v.x}px, ${v.y + d.dismissDy}px) scale(${v.scale})`;
      if (backdropRef.current) backdropRef.current.style.opacity = String(1 - dismissProgress(d.dismissDy, boundsRef.current.viewport.height) * 0.8);
    }
  };

  const endPointer = (event: ReactPointerEvent, cancelled: boolean) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = local(event);
    pointers.current.delete(event.pointerId);
    try {
      stageRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // Not captured: nothing to release.
    }

    if (pinchStart.current) {
      if (pointers.current.size < 2) {
        pinchStart.current = null;
        const rest = Array.from(pointers.current.values())[0];
        // One finger left on the glass: carry on as a pan from where it is, without a jump.
        if (rest) beginDrag(rest, event.timeStamp, 'pan');
        else drag.current = null;
        apply(clampView(viewRef.current, boundsRef.current, limitsRef.current), true);
      }
      return;
    }

    const d = drag.current;
    drag.current = null;
    if (!d) return;

    if (d.mode === 'dismiss') {
      if (!cancelled && shouldDismiss(d.dismissDy, d.velocityY, viewRef.current, limitsRef.current)) {
        onClose();
      } else {
        resetDismissVisuals(true);
      }
      return;
    }
    if (cancelled || !isTap(d.moved, event.timeStamp - d.startTime)) return;

    const tap = { time: event.timeStamp, x: point.x, y: point.y };
    if (isDoubleTap(lastTap.current, tap)) {
      lastTap.current = null;
      apply(toggleZoom(viewRef.current, point.x, point.y, boundsRef.current, limitsRef.current), true);
      return;
    }
    lastTap.current = tap;

    // A tap on the empty backdrop (outside the picture/table) closes it.
    const box = contentRef.current?.getBoundingClientRect();
    if (box && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) onClose();
  };

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={label}>
      <div ref={backdropRef} className="lightbox-backdrop" />
      <div
        ref={stageRef}
        className="lightbox-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endPointer(event, false)}
        onPointerCancel={(event) => endPointer(event, true)}
      >
        <div ref={contentRef} className="lightbox-content" style={image ? { width: image.width, height: image.height } : undefined}>
          {image ? (
            show && (
              <img
                className="lightbox-image"
                src={show}
                alt={image.alt ?? ''}
                draggable={false}
                decoding="async"
                style={inverted ? { filter: 'invert(1) hue-rotate(180deg)' } : undefined}
              />
            )
          ) : (
            <div ref={domRef} className="lightbox-dom" style={contentStyle} />
          )}
        </div>
        {image && !show && <div className="lightbox-loading">Loading…</div>}
      </div>
      <div className="lightbox-toolbar">
        {canInvert && image && (
          <button type="button" className="lightbox-invert" aria-pressed={inverted} onClick={() => setInverted((value) => !value)}>
            Invert
          </button>
        )}
        <button ref={closeRef} type="button" className="lightbox-close" aria-label="Close" onClick={onClose}>
          &times;
        </button>
      </div>
    </div>
  );
}
