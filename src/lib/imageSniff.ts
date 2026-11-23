// Reads an image's dimensions (and a few facts that decide how to handle it)
// straight from its header bytes - synchronously, with no decoding - so the
// reader can reserve the exact space for an <img> before it is mounted and
// loading an image never moves the text around it.
//
// Pure functions over bytes. Every read is bounds-checked: truncated or corrupt
// input returns null, never throws.

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'svg';

export interface ImageHeader {
  format: ImageFormat;
  /** The format's own MIME type, from the bytes - not from whatever a manifest claims. */
  mime: string;
  /** Size as DISPLAYED: EXIF orientation 5-8 (a quarter turn) swaps width and height. */
  width: number;
  height: number;
  /** Can have transparent pixels (PNG alpha / tRNS, WebP alpha, GIF is not considered). */
  hasAlpha: boolean;
  /** More than one frame (APNG, animated GIF, animated WebP): must be passed through untouched. */
  animated: boolean;
  /** EXIF orientation, 1-8 (1 when absent). JPEG only. */
  orientation: number;
}

/** Anything beyond this per side is treated as corrupt rather than trusted. */
export const MAX_SANE_DIMENSION = 100_000;

const MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

function sane(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= MAX_SANE_DIMENSION && height <= MAX_SANE_DIMENSION;
}

function header(format: ImageFormat, width: number, height: number, extra: Partial<ImageHeader> = {}): ImageHeader | null {
  if (!sane(width, height)) return null;
  return { format, mime: MIME[format], width, height, hasAlpha: false, animated: false, orientation: 1, ...extra };
}

// Bounds-checked big/little endian reads; undefined when out of range.
const u8 = (b: Uint8Array, o: number): number | undefined => (o >= 0 && o < b.length ? b[o] : undefined);
function u16be(b: Uint8Array, o: number): number | undefined {
  return o >= 0 && o + 2 <= b.length ? (b[o] << 8) | b[o + 1] : undefined;
}
function u16le(b: Uint8Array, o: number): number | undefined {
  return o >= 0 && o + 2 <= b.length ? b[o] | (b[o + 1] << 8) : undefined;
}
function u32be(b: Uint8Array, o: number): number | undefined {
  return o >= 0 && o + 4 <= b.length ? ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0 : undefined;
}
function u24le(b: Uint8Array, o: number): number | undefined {
  return o >= 0 && o + 3 <= b.length ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) : undefined;
}
function ascii(b: Uint8Array, o: number, text: string): boolean {
  if (o < 0 || o + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[o + i] !== text.charCodeAt(i)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function sniffPng(b: Uint8Array): ImageHeader | null {
  if (!PNG_SIGNATURE.every((v, i) => b[i] === v)) return null;
  if (!ascii(b, 12, 'IHDR')) return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  const colorType = u8(b, 25);
  if (width === undefined || height === undefined || colorType === undefined) return null;

  // Walk the chunks up to the first IDAT: an APNG announces itself with acTL
  // before it, and palette/greyscale/RGB images are transparent through tRNS.
  let hasAlpha = colorType === 4 || colorType === 6;
  let animated = false;
  let at = 8;
  for (let guard = 0; guard < 64; guard++) {
    const length = u32be(b, at);
    if (length === undefined || at + 8 > b.length) break;
    if (ascii(b, at + 4, 'IDAT')) break;
    if (ascii(b, at + 4, 'acTL')) animated = true;
    if (ascii(b, at + 4, 'tRNS')) hasAlpha = true;
    at += 12 + length;
  }
  return header('png', width, height, { hasAlpha, animated });
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

function exifOrientation(b: Uint8Array, start: number, end: number): number {
  // start: first byte after "Exif\0\0" (the TIFF header).
  const little = ascii(b, start, 'II');
  if (!little && !ascii(b, start, 'MM')) return 1;
  const r16 = (o: number) => (little ? u16le(b, o) : u16be(b, o));
  const r32 = (o: number): number | undefined => {
    const lo = r16(o);
    const hi = r16(o + 2);
    if (lo === undefined || hi === undefined) return undefined;
    return little ? ((hi << 16) | lo) >>> 0 : ((lo << 16) | hi) >>> 0;
  };
  if (r16(start + 2) !== 42) return 1;
  const ifd = r32(start + 4);
  if (ifd === undefined) return 1;
  const entries = r16(start + ifd);
  if (entries === undefined) return 1;
  for (let i = 0; i < entries && i < 64; i++) {
    const entry = start + ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (r16(entry) === 0x0112) {
      const value = r16(entry + 8);
      return value !== undefined && value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function sniffJpeg(b: Uint8Array): ImageHeader | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let orientation = 1;
  let at = 2;
  for (let guard = 0; guard < 512; guard++) {
    // Skip to the next marker (0xFF, then a non-0x00/0xFF byte).
    while (u8(b, at) === 0xff && u8(b, at + 1) === 0xff) at++;
    if (u8(b, at) !== 0xff) return null;
    const marker = u8(b, at + 1);
    if (marker === undefined) return null;
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan with no frame header seen
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2; // standalone markers carry no length
      continue;
    }
    const length = u16be(b, at + 2);
    if (length === undefined || length < 2) return null;

    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      const height = u16be(b, at + 5);
      const width = u16be(b, at + 7);
      if (width === undefined || height === undefined) return null;
      const turned = orientation >= 5;
      return header('jpeg', turned ? height : width, turned ? width : height, { orientation });
    }
    if (marker === 0xe1 && ascii(b, at + 4, 'Exif\0\0')) {
      orientation = exifOrientation(b, at + 10, Math.min(b.length, at + 2 + length));
    }
    at += 2 + length;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

function sniffGif(b: Uint8Array): ImageHeader | null {
  if (!ascii(b, 0, 'GIF87a') && !ascii(b, 0, 'GIF89a')) return null;
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  const flags = u8(b, 10);
  if (width === undefined || height === undefined || flags === undefined) return null;

  // Count frames: walk the blocks after the (optional) global colour table.
  let at = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  let frames = 0;
  for (let guard = 0; guard < 100_000 && frames < 2; guard++) {
    const block = u8(b, at);
    if (block === undefined || block === 0x3b) break;
    if (block === 0x21) {
      at += 2; // introducer + label
      for (let sub = u8(b, at); sub !== undefined && sub !== 0; sub = u8(b, at)) at += 1 + sub;
      at += 1;
    } else if (block === 0x2c) {
      frames++;
      const local = u8(b, at + 9);
      if (local === undefined) break;
      at += 10 + (local & 0x80 ? 3 * 2 ** ((local & 0x07) + 1) : 0) + 1; // descriptor, local table, LZW min code size
      for (let sub = u8(b, at); sub !== undefined && sub !== 0; sub = u8(b, at)) at += 1 + sub;
      at += 1;
    } else {
      break;
    }
  }
  return header('gif', width, height, { animated: frames > 1 });
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

function sniffWebp(b: Uint8Array): ImageHeader | null {
  if (!ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null;
  if (ascii(b, 12, 'VP8X')) {
    const flags = u8(b, 20);
    const w = u24le(b, 24);
    const h = u24le(b, 27);
    if (flags === undefined || w === undefined || h === undefined) return null;
    return header('webp', w + 1, h + 1, { hasAlpha: (flags & 0x10) !== 0, animated: (flags & 0x02) !== 0 });
  }
  if (ascii(b, 12, 'VP8L')) {
    if (u8(b, 20) !== 0x2f) return null;
    if (b.length < 25) return null;
    // 14 bits width-1, 14 bits height-1, 1 bit alpha - packed little-endian; read the 4 bytes LE.
    const le = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return header('webp', (le & 0x3fff) + 1, ((le >>> 14) & 0x3fff) + 1, { hasAlpha: ((le >>> 28) & 1) === 1 });
  }
  if (ascii(b, 12, 'VP8 ')) {
    if (u8(b, 23) !== 0x9d || u8(b, 24) !== 0x01 || u8(b, 25) !== 0x2a) return null;
    const w = u16le(b, 26);
    const h = u16le(b, 28);
    if (w === undefined || h === undefined) return null;
    return header('webp', w & 0x3fff, h & 0x3fff);
  }
  return null;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

const SVG_LENGTH = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i;

function svgNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = SVG_LENGTH.exec(value);
  return match ? Number(match[1]) : undefined; // percentages, em, mm...: not a pixel size
}

function sniffSvg(b: Uint8Array): ImageHeader | null {
  // Only the opening <svg ...> tag matters; decode a bounded prefix.
  const text = new TextDecoder('utf-8').decode(b.subarray(0, 8192));
  if (!/^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text.replace(/^﻿/, ''))) return null;
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const attribute = (name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(2).find((v) => v !== undefined);

  const viewBox = attribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const box = viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0 ? viewBox : null;
  const w = svgNumber(attribute('width'));
  const h = svgNumber(attribute('height'));

  let width: number | undefined;
  let height: number | undefined;
  if (w && h) {
    width = w;
    height = h;
  } else if (box) {
    // Only the aspect ratio is known from the viewBox: use its own units, scaled to a sensible size when the
    // other side is given (width alone, or height alone).
    if (w) {
      width = w;
      height = (w * box[3]) / box[2];
    } else if (h) {
      height = h;
      width = (h * box[2]) / box[3];
    } else {
      width = box[2];
      height = box[3];
    }
  }
  if (width === undefined || height === undefined) return null;
  return header('svg', Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
}

// ---------------------------------------------------------------------------

/** Dimensions and handling facts for PNG, JPEG, GIF, WebP and SVG; null for anything else, truncated or corrupt. */
export function sniffImage(bytes: Uint8Array): ImageHeader | null {
  try {
    return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffGif(bytes) ?? sniffWebp(bytes) ?? sniffSvg(bytes);
  } catch {
    return null;
  }
}
