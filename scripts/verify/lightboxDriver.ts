// Runs INSIDE headless Chromium: mounts the REAL ImageLightbox component and drives it
// with synthetic Pointer Events, the same events a finger produces.
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ImageLightbox from '../../src/components/ImageLightbox';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Props = Parameters<typeof ImageLightbox>[0];

let current: { root: Root; host: HTMLElement; closed: boolean } | null = null;

export async function mountLightbox(props: Omit<Props, 'onClose'>) {
  unmountLightbox();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const state = { root, host, closed: false };
  current = state;
  root.render(
    createElement(ImageLightbox, {
      ...props,
      onClose: () => {
        state.closed = true;
        queueMicrotask(() => root.unmount());
      },
    }),
  );
  await sleep(60);
}

export function unmountLightbox() {
  if (!current) return;
  current.root.unmount();
  current.host.remove();
  current = null;
}

export const lightboxIsOpen = () => Boolean(current && !current.closed && document.querySelector('.lightbox'));
export const stage = () => document.querySelector<HTMLElement>('.lightbox-stage')!;
export const content = () => document.querySelector<HTMLElement>('.lightbox-content')!;

/** The content box's current transform, read back from the browser's computed style. */
export function view() {
  const m = new DOMMatrix(getComputedStyle(content()).transform);
  const rect = content().getBoundingClientRect();
  return { scale: m.a, x: m.e, y: m.f, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }, viewport: { width: stage().clientWidth, height: stage().clientHeight } };
}

function fire(type: string, id: number, x: number, y: number) {
  stage().dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
}

export async function tap(x: number, y: number) {
  fire('pointerdown', 1, x, y);
  await sleep(30);
  fire('pointerup', 1, x, y);
}

export async function doubleTap(x: number, y: number) {
  await tap(x, y);
  await sleep(70);
  await tap(x, y);
  await sleep(260); // the settle animation
}

export async function drag(from: [number, number], to: [number, number], { steps = 10, stepMs = 12 } = {}) {
  fire('pointerdown', 1, from[0], from[1]);
  for (let i = 1; i <= steps; i++) {
    await sleep(stepMs);
    fire('pointermove', 1, from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
  }
  fire('pointerup', 1, to[0], to[1]);
  await sleep(260);
}

/** Two fingers symmetric around (cx, cy), moving from `startGap` apart to `endGap` apart. */
export async function pinchGesture(cx: number, cy: number, startGap: number, endGap: number, steps = 10) {
  fire('pointerdown', 1, cx - startGap / 2, cy);
  fire('pointerdown', 2, cx + startGap / 2, cy);
  for (let i = 1; i <= steps; i++) {
    await sleep(12);
    const gap = startGap + ((endGap - startGap) * i) / steps;
    fire('pointermove', 1, cx - gap / 2, cy);
    fire('pointermove', 2, cx + gap / 2, cy);
  }
  fire('pointerup', 2, cx + endGap / 2, cy);
  fire('pointerup', 1, cx - endGap / 2, cy);
  await sleep(260);
}
