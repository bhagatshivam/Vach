import { describe, expect, it } from 'vitest';
import { FONT_FAMILY_OPTIONS, FONT_FAMILY_STACKS } from './readerSettings';

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'system-ui']);
const families = (stack: string) => stack.split(',').map((f) => f.trim().replace(/^"|"$/g, ''));

describe('font stacks', () => {
  it.each(FONT_FAMILY_OPTIONS.map((o) => [o.id, o.stack] as const))('%s names a Devanagari-capable family after its reading font and before the generic keyword', (_id, stack) => {
    const list = families(stack);
    const devanagari = list.findIndex((f) => /Devanagari/.test(f));
    expect(devanagari).toBeGreaterThan(0); // after the reading font(s)
    const generic = list.findIndex((f) => f === 'serif' || f === 'sans-serif');
    expect(generic).toBe(list.length - 1); // the generic keyword stays last
    expect(devanagari).toBeLessThan(generic);
  });

  it.each(FONT_FAMILY_OPTIONS.map((o) => [o.id, o.stack] as const))('%s keeps its original leading fonts in order', (id, stack) => {
    const lead: Record<string, string[]> = {
      serif: ['Georgia', 'Cambria', 'Times New Roman', 'Times'],
      sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial'],
      literata: ['Literata', 'Georgia'],
      merriweather: ['Merriweather', 'Georgia'],
      atkinson: ['Atkinson Hyperlegible', 'system-ui'],
    };
    expect(families(stack).slice(0, lead[id].length)).toEqual(lead[id]);
  });

  it('exposes every option through FONT_FAMILY_STACKS and ends each stack with a generic family', () => {
    for (const option of FONT_FAMILY_OPTIONS) {
      expect(FONT_FAMILY_STACKS[option.id]).toBe(option.stack);
      expect(GENERIC.has(families(option.stack).at(-1)!)).toBe(true);
    }
  });
});
