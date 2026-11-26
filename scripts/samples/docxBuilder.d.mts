// Types for docxBuilder.mjs, so tests can build Word documents in memory.
export function esc(text: string): string;
export function run(text: string, options?: { bold?: boolean; italic?: boolean }): string;
export function p(content: string, style?: string): string;
export function heading(level: 1 | 2 | 3, text: string): string;
export function li(text: string, numId?: number, level?: number): string;
export function table(rows: Array<Array<string | { text: string; span?: number; vMerge?: 'restart' | 'continue' }>>, options?: { header?: boolean }): string;
export function picture(rId: string, widthEmu: number, heightEmu: number, alt?: string): string;
export function footnoteRef(id: number): string;
export function endnoteRef(id: number): string;
export function link(anchor: string, text: string): string;
export function bookmark(id: number, name: string, inner: string): string;
export function buildDocx(
  body: string,
  options?: { title?: string; images?: Array<{ name: string; bytes: Uint8Array }>; footnotes?: Array<[number, string]>; endnotes?: Array<[number, string]> },
): Promise<Uint8Array>;
export function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number], level?: number): Uint8Array;
export function rng(seed: number): () => number;
export function paragraphText(random: () => number, words: number): string;
