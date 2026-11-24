import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apply } = vi.hoisted(() => ({ apply: vi.fn(async (_options?: unknown) => {}) }));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ apply }) }));

import { THEME_COLORS } from './readerSettings';
import { applyCachedTheme, applySystemTheme, isLightBackground, normalizeHex, resetSystemThemeForTests } from './systemTheme';

beforeEach(() => {
  resetSystemThemeForTests();
  apply.mockClear();
  localStorage.clear();
  document.documentElement.removeAttribute('style');
  document.body.removeAttribute('style');
});

afterEach(() => vi.restoreAllMocks());

describe('normalizeHex', () => {
  it('expands #rgb, lower-cases, and rejects anything that is not a hex colour', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('#F4ECD8')).toBe('#f4ecd8');
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('url(x)')).toBeNull();
  });
});

describe('isLightBackground (which way the bar icons go)', () => {
  it('sepia and beige are light (dark icons); night is dark (light icons)', () => {
    expect(isLightBackground(THEME_COLORS.sepia.background)).toBe(true);
    expect(isLightBackground(THEME_COLORS.beige.background)).toBe(true);
    expect(isLightBackground(THEME_COLORS.night.background)).toBe(false);
  });

  it('custom colours go to whichever icons contrast more', () => {
    expect(isLightBackground('#ffffff')).toBe(true);
    expect(isLightBackground('#000000')).toBe(false);
    expect(isLightBackground('#1c1917')).toBe(false);
    expect(isLightBackground('#fdfcfb')).toBe(true);
    expect(isLightBackground('#666666')).toBe(false); // mid greys go to whichever icons contrast more
    expect(isLightBackground('#888888')).toBe(true);
  });
});

describe('applySystemTheme', () => {
  it.each([
    ['sepia', THEME_COLORS.sepia, true],
    ['beige', THEME_COLORS.beige, true],
    ['night', THEME_COLORS.night, false],
    ['custom', { background: '#223344', text: '#eeeeee' }, false],
  ])('%s: paints <html> and <body> in the theme colour and tells the native side', (_name, colors, light) => {
    applySystemTheme(colors.background, colors.text);
    const expected = normalizeHex(colors.background)!;
    for (const el of [document.documentElement, document.body]) {
      const probe = document.createElement('i');
      probe.style.backgroundColor = expected;
      expect(el.style.backgroundColor).toBe(probe.style.backgroundColor);
    }
    expect(document.documentElement.style.colorScheme).toBe(light ? 'light' : 'dark');
    expect(apply).toHaveBeenCalledWith({ background: expected, darkIcons: light });
  });

  it('switching theme repaints and re-sends; the same theme twice does nothing the second time', () => {
    applySystemTheme('#f4ecd8', '#3b2f1e');
    applySystemTheme('#f4ecd8', '#3b2f1e');
    expect(apply).toHaveBeenCalledTimes(1);
    applySystemTheme('#121212', '#d8d8d8');
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith({ background: '#121212', darkIcons: false });
  });

  it('ignores a colour it cannot parse (nothing painted, nothing sent)', () => {
    applySystemTheme('not-a-colour');
    expect(document.documentElement.style.backgroundColor).toBe('');
    expect(apply).not.toHaveBeenCalled();
  });

  it('never throws when the native plugin is missing or rejects', async () => {
    apply.mockRejectedValueOnce(new Error('"SystemTheme" plugin is not implemented on web'));
    expect(() => applySystemTheme('#ffffff')).not.toThrow();
    await Promise.resolve();
  });

  it('says it again after a resize (Android resets the window colours when the phone is turned)', () => {
    applySystemTheme('#121212', '#d8d8d8');
    apply.mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(apply).toHaveBeenCalledWith({ background: '#121212', darkIcons: false });
  });
});

describe('applyCachedTheme (first paint on the next launch)', () => {
  it('paints the last theme before anything renders', () => {
    applySystemTheme('#121212', '#d8d8d8');
    resetSystemThemeForTests();
    document.documentElement.removeAttribute('style');
    apply.mockClear();

    applyCachedTheme();
    expect(document.documentElement.style.backgroundColor).not.toBe('');
    expect(apply).toHaveBeenCalledWith({ background: '#121212', darkIcons: false });
  });

  it('does nothing without a cache, or with a corrupt one', () => {
    applyCachedTheme();
    localStorage.setItem('vach_system_theme', '{nope');
    expect(() => applyCachedTheme()).not.toThrow();
    localStorage.setItem('vach_system_theme', JSON.stringify({ background: 'javascript:alert(1)' }));
    applyCachedTheme();
    expect(document.documentElement.style.backgroundColor).toBe('');
    expect(apply).not.toHaveBeenCalled();
  });
});
