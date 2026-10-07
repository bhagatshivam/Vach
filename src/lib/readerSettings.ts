import { Preferences } from '@capacitor/preferences';

export type FontFamily = 'serif' | 'sans' | 'literata' | 'merriweather' | 'atkinson';
export type ThemeName = 'sepia' | 'night' | 'beige' | 'custom';

export interface ReaderSettings {
  fontFamily: FontFamily;
  fontSize: number;
  lineHeight: number;
  theme: ThemeName;
  customBackground: string;
  customText: string;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontFamily: 'serif',
  fontSize: 18,
  lineHeight: 1.6,
  theme: 'sepia',
  customBackground: '#1c1917',
  customText: '#f3f4f6',
};

export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 28;
export const LINE_HEIGHT_MIN = 1.2;
export const LINE_HEIGHT_MAX = 2.2;

const SETTINGS_KEY = 'reader_settings';

const KNOWN_THEMES: readonly ThemeName[] = ['sepia', 'night', 'beige', 'custom'];
const KNOWN_FONT_FAMILIES: readonly FontFamily[] = ['serif', 'sans', 'literata', 'merriweather', 'atkinson'];
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Validates a settings object loaded from storage, field by field, falling
 * back to the matching DEFAULT_READER_SETTINGS field for anything that
 * isn't one of the known-good values - rather than trusting the stored
 * JSON's shape. A corrupted/hand-edited Preferences value (or, on a device
 * where something else can reach window.Capacitor.Plugins.Preferences,
 * anything that writes one) used to crash the whole reader screen to a
 * blank page: an invalid `theme` isn't a key in THEME_COLORS, and
 * ReaderScreen read that object unconditionally. Every field here now has
 * a defined, safe fallback instead of ever reaching that unconditional
 * lookup with an unvalidated value.
 */
function validateReaderSettings(raw: Partial<ReaderSettings>): ReaderSettings {
  return {
    theme: KNOWN_THEMES.includes(raw.theme as ThemeName) ? (raw.theme as ThemeName) : DEFAULT_READER_SETTINGS.theme,
    fontFamily: KNOWN_FONT_FAMILIES.includes(raw.fontFamily as FontFamily)
      ? (raw.fontFamily as FontFamily)
      : DEFAULT_READER_SETTINGS.fontFamily,
    fontSize: clampNumber(raw.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULT_READER_SETTINGS.fontSize),
    lineHeight: clampNumber(raw.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_READER_SETTINGS.lineHeight),
    customBackground:
      typeof raw.customBackground === 'string' && HEX_COLOR.test(raw.customBackground)
        ? raw.customBackground
        : DEFAULT_READER_SETTINGS.customBackground,
    customText:
      typeof raw.customText === 'string' && HEX_COLOR.test(raw.customText)
        ? raw.customText
        : DEFAULT_READER_SETTINGS.customText,
  };
}

export async function getReaderSettings(): Promise<ReaderSettings> {
  const { value } = await Preferences.get({ key: SETTINGS_KEY });
  if (!value) return DEFAULT_READER_SETTINGS;
  try {
    const parsed = JSON.parse(value) as Partial<ReaderSettings>;
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_READER_SETTINGS;
    return validateReaderSettings(parsed);
  } catch {
    return DEFAULT_READER_SETTINGS;
  }
}

export async function saveReaderSettings(settings: ReaderSettings): Promise<void> {
  await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify(settings) });
}

// Offline app, zero network calls ever - fonts beyond the two generic system
// stacks are bundled locally via @fontsource (imported in main.tsx) rather
// than loaded from a CDN. Literata (Google Play Books' own serif),
// Merriweather (one of the most widely used prose serifs on the web), and
// Atkinson Hyperlegible (purpose-built for legibility) were all picked
// specifically for long-form reading, not just popularity.
export const FONT_FAMILY_OPTIONS: { id: FontFamily; label: string; stack: string }[] = [
  { id: 'serif', label: 'Serif', stack: 'Georgia, Cambria, "Times New Roman", Times, serif' },
  { id: 'sans', label: 'Sans', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  { id: 'literata', label: 'Literata', stack: '"Literata", Georgia, serif' },
  { id: 'merriweather', label: 'Merriweather', stack: '"Merriweather", Georgia, serif' },
  { id: 'atkinson', label: 'Atkinson', stack: '"Atkinson Hyperlegible", system-ui, sans-serif' },
];

export const FONT_FAMILY_STACKS: Record<FontFamily, string> = Object.fromEntries(
  FONT_FAMILY_OPTIONS.map((option) => [option.id, option.stack]),
) as Record<FontFamily, string>;

// Sepia and beige used to be #f4ecd8 / #ede6d6 - a difference of only
// (7, 6, 2) per RGB channel, effectively indistinguishable on a real screen.
// Beige is now deliberately more neutral (a smaller red-minus-blue "warmth"
// skew: 15 vs sepia's 28) and noticeably darker/more muted, so it reads as a
// plain light neutral tone next to sepia's warm, yellowed-paper look.
export const THEME_COLORS: Record<Exclude<ThemeName, 'custom'>, { background: string; text: string }> = {
  sepia: { background: '#f4ecd8', text: '#3b2f1e' },
  night: { background: '#121212', text: '#d8d8d8' },
  beige: { background: '#ddd7c8', text: '#2b2b2b' },
};
