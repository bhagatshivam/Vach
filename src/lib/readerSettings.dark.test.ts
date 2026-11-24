import { describe, expect, it } from 'vitest';
import { isDarkTheme } from './readerSettings';

describe('isDarkTheme', () => {
  it('the night theme is dark; the light themes are not', () => {
    expect(isDarkTheme({ theme: 'night', customBackground: '#ffffff' })).toBe(true);
    expect(isDarkTheme({ theme: 'beige', customBackground: '#000000' })).toBe(false);
    expect(isDarkTheme({ theme: 'sepia', customBackground: '#000000' })).toBe(false);
  });

  it('a custom theme is judged by the luminance of its background', () => {
    expect(isDarkTheme({ theme: 'custom', customBackground: '#1c1917' })).toBe(true);
    expect(isDarkTheme({ theme: 'custom', customBackground: '#000' })).toBe(true);
    expect(isDarkTheme({ theme: 'custom', customBackground: '#f5f0e6' })).toBe(false);
    expect(isDarkTheme({ theme: 'custom', customBackground: '#fff' })).toBe(false);
  });
});
