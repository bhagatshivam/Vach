import { useEffect } from 'react';
import { registerPlugin } from '@capacitor/core';

// Keeps everything OUTSIDE the screens' own boxes the colour of the active
// reading theme, so no white frame or white bar can ever show: the page
// background (<html>/<body>, which is what any uncovered or overscrolled pixel
// shows) and, through the tiny native SystemTheme plugin, the Android window,
// the WebView and the status/navigation bars' icon contrast.
//
// Screens call useSystemTheme() with the colours they already paint; a copy of
// the last colours is cached so the next launch can paint them before React
// has even started (applyCachedTheme, called from main.tsx).

interface SystemThemePlugin {
  apply(options: { background: string; darkIcons: boolean }): Promise<void>;
}

const SystemTheme = registerPlugin<SystemThemePlugin>('SystemTheme');

const CACHE_KEY = 'vach_system_theme';
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** "#abc" -> "#aabbcc"; anything that is not a hex colour -> null. */
export function normalizeHex(color: string): string | null {
  if (!HEX.test(color)) return null;
  const hex = color.slice(1).toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
}

/** Relative luminance (0 dark .. 1 light) of a #rrggbb colour. */
export function luminanceOf(hex: string): number {
  const channel = (offset: number) => {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * Is this a light background (so system-bar icons should be dark)? 0.4 on
 * relative luminance sits between the lightest dark theme and the darkest
 * light one, and a mid-tone custom colour goes to whichever icons contrast more.
 */
export function isLightBackground(hex: string): boolean {
  const lum = luminanceOf(hex);
  // Contrast of black icons vs white icons against this background.
  return (lum + 0.05) / 0.05 >= 1.05 / (lum + 0.05);
}

let lastKey = '';
let lastNative: { background: string; darkIcons: boolean } | null = null;
let resizeHooked = false;

function sendToNative(options: { background: string; darkIcons: boolean }): void {
  lastNative = options;
  try {
    // Resolves on Android; rejects (not implemented) in a browser or test, which is fine.
    void SystemTheme.apply(options).catch(() => {});
  } catch {
    // Never let the frame colour break the screen.
  }
}

/**
 * Paints the theme onto the page and the Android window. Idempotent: the same
 * colours twice do nothing the second time.
 */
export function applySystemTheme(background: string, text?: string): void {
  const bg = normalizeHex(background);
  if (!bg) return;
  const textColor = text ? normalizeHex(text) : null;
  const key = `${bg}|${textColor ?? ''}`;
  const light = isLightBackground(bg);

  if (key !== lastKey) {
    lastKey = key;
    const root = document.documentElement;
    root.style.backgroundColor = bg;
    root.style.colorScheme = light ? 'light' : 'dark';
    if (document.body) document.body.style.backgroundColor = bg;
    if (textColor) {
      root.style.color = textColor;
      if (document.body) document.body.style.color = textColor;
    }
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ background: bg, text: textColor }));
    } catch {
      // Private mode / storage disabled: only the next launch's first paint is affected.
    }
    sendToNative({ background: bg, darkIcons: light });
  }

  // Turning the phone (or a UI-mode change) makes Android reset the window
  // colours; say it again once the new layout is in.
  if (!resizeHooked && typeof window !== 'undefined') {
    resizeHooked = true;
    window.addEventListener('resize', () => {
      if (lastNative) sendToNative(lastNative);
    });
  }
}

/** Paints the last-used theme synchronously, before the first render (no flash of the wrong colour on launch). */
export function applyCachedTheme(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { background?: unknown; text?: unknown };
    if (typeof parsed.background === 'string') applySystemTheme(parsed.background, typeof parsed.text === 'string' ? parsed.text : undefined);
  } catch {
    // Missing or corrupt cache: the CSS fallback colours stay.
  }
}

/** For tests: forget what was applied. */
export function resetSystemThemeForTests(): void {
  lastKey = '';
  lastNative = null;
}

/** A screen calls this with the colours it paints. `enabled` waits for saved settings so a default theme never flashes. */
export function useSystemTheme(background: string, text: string, enabled = true): void {
  useEffect(() => {
    if (enabled) applySystemTheme(background, text);
  }, [background, text, enabled]);
}
