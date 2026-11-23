import { describe, expect, it } from 'vitest';
import { MAX_SANE_DIMENSION, sniffImage } from './imageSniff';

// ---- tiny builders: just enough of each format to carry a header ----------------

const bytes = (...parts: Array<number[] | Uint8Array | string>): Uint8Array => {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') for (const c of part) out.push(c.charCodeAt(0));
    else out.push(...part);
  }
  return Uint8Array.from(out);
};
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

function pngChunk(type: string, data: number[]): number[] {
  return [...be32(data.length), ...type.split('').map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0]; // CRC not checked
}
function png(width: number, height: number, colorType = 2, extra: Array<[string, number[]]> = []): Uint8Array {
  const ihdr = [...be32(width), ...be32(height), 8, colorType, 0, 0, 0];
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pngChunk('IHDR', ihdr), ...extra.map(([t, d]) => pngChunk(t, d)), pngChunk('IDAT', [0, 0, 0, 0]), pngChunk('IEND', []));
}

function jpeg(width: number, height: number, orientation?: number, marker = 0xc0): Uint8Array {
  const parts: Array<number[] | string> = [[0xff, 0xd8]];
  if (orientation !== undefined) {
    // APP1 "Exif\0\0" + a little-endian TIFF header with one IFD0 entry: Orientation (0x0112).
    const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0];
    parts.push([0xff, 0xe1, ...be16(2 + 6 + tiff.length)], 'Exif\0\0', tiff);
  }
  parts.push([0xff, 0xe0, 0, 4, 0, 0]); // some other segment
  parts.push([0xff, marker, 0, 17, 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  parts.push([0xff, 0xd9]);
  return bytes(...parts);
}

function gif(width: number, height: number, frames = 1): Uint8Array {
  const parts: Array<number[] | string> = ['GIF89a', [...le16(width), ...le16(height), 0x80, 0, 0], [0, 0, 0, 255, 255, 255]]; // 2-entry global table
  for (let i = 0; i < frames; i++) {
    parts.push([0x21, 0xf9, 4, 0, 10, 0, 0, 0]); // graphic control extension
    parts.push([0x2c, 0, 0, 0, 0, ...le16(width), ...le16(height), 0, 2, 2, 0x4c, 0x01, 0]); // image descriptor + 1 data block
  }
  parts.push([0x3b]);
  return bytes(...parts);
}

function webpLossy(width: number, height: number): Uint8Array {
  return bytes('RIFF', le32(40), 'WEBP', 'VP8 ', le32(20), [0, 0, 0], [0x9d, 0x01, 0x2a], le16(width), le16(height), new Array(10).fill(0));
}
function webpLossless(width: number, height: number, alpha = false): Uint8Array {
  const bits = ((width - 1) | ((height - 1) << 14) | ((alpha ? 1 : 0) << 28)) >>> 0;
  return bytes('RIFF', le32(30), 'WEBP', 'VP8L', le32(10), [0x2f], le32(bits), new Array(8).fill(0));
}
function webpExtended(width: number, height: number, flags: number): Uint8Array {
  return bytes('RIFF', le32(30), 'WEBP', 'VP8X', le32(10), [flags, 0, 0, 0], le24(width - 1), le24(height - 1), new Array(8).fill(0));
}

const svg = (tag: string) => bytes(`<?xml version="1.0"?>\n<svg ${tag}><rect width="1" height="1"/></svg>`);

// ---------------------------------------------------------------------------------------

describe('PNG', () => {
  it('reads the size from IHDR', () => {
    expect(sniffImage(png(4000, 6000))).toMatchObject({ format: 'png', mime: 'image/png', width: 4000, height: 6000, hasAlpha: false, animated: false });
  });

  it('alpha colour types (grey+alpha, RGBA) are transparent', () => {
    expect(sniffImage(png(10, 10, 6))?.hasAlpha).toBe(true);
    expect(sniffImage(png(10, 10, 4))?.hasAlpha).toBe(true);
    expect(sniffImage(png(10, 10, 2))?.hasAlpha).toBe(false);
  });

  it('a tRNS chunk makes a palette image transparent', () => {
    expect(sniffImage(png(10, 10, 3, [['PLTE', [0, 0, 0]], ['tRNS', [0]]]))?.hasAlpha).toBe(true);
    expect(sniffImage(png(10, 10, 3, [['PLTE', [0, 0, 0]]]))?.hasAlpha).toBe(false);
  });

  it('an acTL chunk before the image data marks an APNG as animated', () => {
    expect(sniffImage(png(10, 10, 6, [['acTL', [0, 0, 0, 2, 0, 0, 0, 0]]]))?.animated).toBe(true);
  });
});

describe('JPEG', () => {
  it('reads the size from the frame header, wherever other segments precede it', () => {
    expect(sniffImage(jpeg(3000, 2000))).toMatchObject({ format: 'jpeg', mime: 'image/jpeg', width: 3000, height: 2000, orientation: 1, hasAlpha: false });
  });

  it.each([0xc0, 0xc1, 0xc2, 0xc9])('handles frame marker 0x%s (baseline, extended, progressive, arithmetic)', (marker) => {
    expect(sniffImage(jpeg(640, 480, undefined, marker))).toMatchObject({ width: 640, height: 480 });
  });

  it('EXIF orientation 6 or 8 (a quarter turn) swaps the displayed width and height', () => {
    expect(sniffImage(jpeg(4000, 3000, 6))).toMatchObject({ width: 3000, height: 4000, orientation: 6 });
    expect(sniffImage(jpeg(4000, 3000, 8))).toMatchObject({ width: 3000, height: 4000, orientation: 8 });
    expect(sniffImage(jpeg(4000, 3000, 5))).toMatchObject({ width: 3000, height: 4000, orientation: 5 });
  });

  it('EXIF orientation 1-4 (no quarter turn) leaves the size alone', () => {
    for (const orientation of [1, 2, 3, 4]) expect(sniffImage(jpeg(4000, 3000, orientation))).toMatchObject({ width: 4000, height: 3000, orientation });
  });

  it('ignores a nonsense orientation value', () => {
    expect(sniffImage(jpeg(400, 300, 9))).toMatchObject({ width: 400, height: 300, orientation: 1 });
  });

  it('has no frame header at all (starts a scan): not an image we can size', () => {
    expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0xff, 0xd9]))).toBeNull();
  });
});

describe('GIF', () => {
  it('reads the logical screen size', () => {
    expect(sniffImage(gif(320, 200))).toMatchObject({ format: 'gif', mime: 'image/gif', width: 320, height: 200, animated: false });
  });

  it('more than one frame is animated', () => {
    expect(sniffImage(gif(64, 64, 2))?.animated).toBe(true);
    expect(sniffImage(gif(64, 64, 5))?.animated).toBe(true);
  });

  it('GIF87a is accepted too', () => {
    const data = gif(10, 20);
    data.set([0x38, 0x37], 3); // "87"
    expect(sniffImage(data)).toMatchObject({ width: 10, height: 20 });
  });
});

describe('WebP', () => {
  it('lossy (VP8 )', () => {
    expect(sniffImage(webpLossy(1200, 800))).toMatchObject({ format: 'webp', mime: 'image/webp', width: 1200, height: 800, hasAlpha: false });
  });

  it('lossless (VP8L) with and without alpha', () => {
    expect(sniffImage(webpLossless(512, 256))).toMatchObject({ width: 512, height: 256, hasAlpha: false });
    expect(sniffImage(webpLossless(512, 256, true))?.hasAlpha).toBe(true);
  });

  it('extended (VP8X): canvas size, alpha flag and animation flag', () => {
    expect(sniffImage(webpExtended(2000, 3000, 0))).toMatchObject({ width: 2000, height: 3000, hasAlpha: false, animated: false });
    expect(sniffImage(webpExtended(2000, 3000, 0x10))?.hasAlpha).toBe(true);
    expect(sniffImage(webpExtended(2000, 3000, 0x02))?.animated).toBe(true);
  });
});

describe('SVG', () => {
  it('uses the viewBox when there is no width/height', () => {
    expect(sniffImage(svg('xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"'))).toMatchObject({ format: 'svg', mime: 'image/svg+xml', width: 800, height: 600 });
  });

  it('handles viewBox with commas and an offset origin', () => {
    expect(sniffImage(svg('viewBox="10,20,300,150"'))).toMatchObject({ width: 300, height: 150 });
  });

  it('prefers explicit pixel width and height', () => {
    expect(sniffImage(svg('width="400px" height="200" viewBox="0 0 1 1"'))).toMatchObject({ width: 400, height: 200 });
  });

  it('with only one of width/height, derives the other from the viewBox ratio', () => {
    expect(sniffImage(svg('width="300" viewBox="0 0 100 50"'))).toMatchObject({ width: 300, height: 150 });
    expect(sniffImage(svg('height="100" viewBox="0 0 100 50"'))).toMatchObject({ width: 200, height: 100 });
  });

  it('ignores percentage and relative-unit sizes (they are not a pixel size)', () => {
    expect(sniffImage(svg('width="100%" height="100%" viewBox="0 0 640 360"'))).toMatchObject({ width: 640, height: 360 });
    expect(sniffImage(svg('width="50%" height="50%"'))).toBeNull();
  });

  it('single-quoted attributes, a BOM and a doctype and comments before the tag', () => {
    expect(sniffImage(bytes([0xef, 0xbb, 0xbf], "<!-- c -->\n<!DOCTYPE svg>\n<svg viewBox='0 0 50 25'></svg>"))).toMatchObject({ width: 50, height: 25 });
  });

  it('an SVG with no size information at all cannot be sized', () => {
    expect(sniffImage(svg('xmlns="http://www.w3.org/2000/svg"'))).toBeNull();
  });

  it('plain text that merely mentions <svg> later is not an SVG', () => {
    expect(sniffImage(bytes('hello <svg width="1" height="1"> not really'))).toBeNull();
  });
});

describe('truncated, corrupt and unknown input never throws', () => {
  const samples: Record<string, Uint8Array> = {
    png: png(100, 50, 6, [['tRNS', [0]], ['acTL', [0, 0, 0, 1, 0, 0, 0, 0]]]),
    jpeg: jpeg(100, 50, 6),
    gif: gif(100, 50, 3),
    webpLossy: webpLossy(100, 50),
    webpLossless: webpLossless(100, 50, true),
    webpExtended: webpExtended(100, 50, 0x12),
    svg: svg('viewBox="0 0 100 50"'),
  };

  for (const [name, full] of Object.entries(samples)) {
    it(`${name}: every truncation returns a header or null, never throws`, () => {
      for (let length = 0; length <= full.length; length++) {
        expect(() => sniffImage(full.subarray(0, length))).not.toThrow();
      }
    });
  }

  it.each([
    ['empty', new Uint8Array(0)],
    ['one byte', Uint8Array.of(0x89)],
    ['PNG signature only', png(10, 10).subarray(0, 8)],
    ['PNG cut inside IHDR', png(10, 10).subarray(0, 20)],
    ['JPEG magic only', Uint8Array.of(0xff, 0xd8)],
    ['GIF magic only', bytes('GIF89a')],
    ['RIFF without WEBP', bytes('RIFF', le32(4), 'WAVE')],
    ['plain text', bytes('just some text, not an image')],
    ['zeros', new Uint8Array(200)],
    ['a ZIP', bytes('PK\x03\x04', new Array(60).fill(0))],
  ])('%s -> null', (_label, data) => {
    expect(sniffImage(data)).toBeNull();
  });

  it('a corrupt header with absurd dimensions is rejected instead of trusted', () => {
    expect(sniffImage(png(0, 10))).toBeNull();
    expect(sniffImage(png(10, 0))).toBeNull();
    expect(sniffImage(png(MAX_SANE_DIMENSION + 1, 10))).toBeNull();
    expect(sniffImage(png(0xffffffff, 0xffffffff))).toBeNull();
    expect(sniffImage(jpeg(0, 100))).toBeNull();
    expect(sniffImage(gif(0, 100))).toBeNull();
    expect(sniffImage(png(MAX_SANE_DIMENSION, MAX_SANE_DIMENSION))).not.toBeNull();
  });

  it('random bytes behind a valid magic number never throw', () => {
    let seed = 12345;
    const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) & 255;
    const magics = [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0xff, 0xd8], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]];
    for (let i = 0; i < 400; i++) {
      const magic = magics[i % magics.length];
      const noise = Array.from({ length: 4 + (i % 90) }, rand);
      expect(() => sniffImage(Uint8Array.from([...magic, ...noise]))).not.toThrow();
    }
  });
});
