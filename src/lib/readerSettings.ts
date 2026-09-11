import { Preferences } from '@capacitor/preferences';

export type FontFamily = 'serif' | 'sans';
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

const SETTINGS_KEY = 'reader_settings';

export async function getReaderSettings(): Promise<ReaderSettings> {
  const { value } = await Preferences.get({ key: SETTINGS_KEY });
  if (!value) return DEFAULT_READER_SETTINGS;
  try {
    return { ...DEFAULT_READER_SETTINGS, ...(JSON.parse(value) as Partial<ReaderSettings>) };
  } catch {
    return DEFAULT_READER_SETTINGS;
  }
}

export async function saveReaderSettings(settings: ReaderSettings): Promise<void> {
  await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify(settings) });
}

// Offline app, zero network calls ever - no CDN font loading, so this is
// limited to fonts that ship with Android's WebView. Only "serif" and
// "sans-serif" are genuinely distinct as pure generic CSS families; the
// other generics (cursive, fantasy, monospace) aren't fit for reading prose.
// A real curated typeface list needs actual font files bundled into the
// app - straightforward to add once specific fonts are chosen.
export const FONT_FAMILY_STACKS: Record<FontFamily, string> = {
  serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
};

export const THEME_COLORS: Record<Exclude<ThemeName, 'custom'>, { background: string; text: string }> = {
  sepia: { background: '#f4ecd8', text: '#3b2f1e' },
  night: { background: '#121212', text: '#d8d8d8' },
  beige: { background: '#ede6d6', text: '#2b2b2b' },
};
