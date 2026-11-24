#!/usr/bin/env node
// Generates samples/images-sample.epub, the book for checking Phase 3A (the image
// pipeline and lightbox) on a real phone and in headless Chromium. Every image is
// drawn from a tiny pure-JS PNG/GIF/SVG writer so the book is small (well under
// 1 MB) and deterministic: the same script gives the same bytes.
//
//   node scripts/samples/gen-images-sample.mjs
//
// What is in it (chapter -> picture):
//   1  huge.png      4000 x 6000, a few KB because it is flat colour (decodes to ~96 MB)
//      map.png       3200 x 1000, a wide map
//      panel.png     600 x 3000, a tall comic-style panel
//   2  icon.png      24 x 24 (decoration: tapping it must NOT open the lightbox)
//      noattrs.png   an <img> with no width/height attributes at all
//      diagram.png   white background, black lines (the "Invert B&W" case)
//      figure.svg    SVG with a viewBox and no width/height
//      spinner.gif   animated GIF (must pass through untouched)
//      badge.png     transparent PNG (RGBA)
//   0  cover.png     the cover (600 x 900)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(repo, 'samples');
const FIXED = new Date(Date.UTC(2020, 0, 1));

// ---- PNG writer -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
}

/**
 * Encodes a PNG. `pixel(x, y)` returns a palette index (colorType 3), a gray value (0) or
 * [r,g,b,a] (6). Every row uses filter 2 ("Up") so flat artwork compresses to almost nothing.
 */
function png({ width, height, colorType, palette, trns, pixel }) {
  const channels = colorType === 6 ? 4 : 1;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  let prev = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = pixel(x, y);
      if (channels === 4) {
        row[x * 4] = v[0];
        row[x * 4 + 1] = v[1];
        row[x * 4 + 2] = v[2];
        row[x * 4 + 3] = v[3];
      } else row[x] = v;
    }
    const o = y * (stride + 1);
    raw[o] = 2;
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (row[i] - prev[i]) & 255;
    prev = Buffer.from(row);
  }
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, colorType, 0, 0, 0])]);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', Buffer.from(palette.flat())));
  if (trns) parts.push(chunk('tRNS', Buffer.from(trns)));
  parts.push(chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---- artwork ------------------------------------------------------------------------

const PAL = [
  [250, 246, 235], // 0 paper
  [30, 34, 48], // 1 ink
  [196, 64, 52], // 2 red
  [52, 110, 176], // 3 blue
  [226, 178, 58], // 4 gold
  [62, 142, 96], // 5 green
  [180, 200, 220], // 6 pale blue (water)
  [214, 196, 160], // 7 sand
];

/** 4000 x 6000: horizontal bands, a big frame and a few blocks - decodes to 24 MB palette / 96 MB RGBA. */
function hugeImage() {
  const w = 4000;
  const h = 6000;
  return png({
    width: w,
    height: h,
    colorType: 3,
    palette: PAL,
    pixel: (x, y) => {
      if (x < 60 || x >= w - 60 || y < 60 || y >= h - 60) return 1; // frame
      if (x >= 400 && x < 3600 && y >= 600 && y < 1400) return 2;
      if (x >= 400 && x < 1800 && y >= 1800 && y < 4200) return 3;
      if (x >= 2200 && x < 3600 && y >= 1800 && y < 4200) return 4;
      if (Math.abs(x - 2000) + Math.abs(y - 5000) < 700) return 5;
      return Math.floor(y / 750) % 2 === 0 ? 0 : 7;
    },
  });
}

function mapImage() {
  const w = 3200;
  const h = 1000;
  return png({
    width: w,
    height: h,
    colorType: 3,
    palette: PAL,
    pixel: (x, y) => {
      const coast = 500 + Math.round(200 * Math.sin(x / 260));
      if (y > coast + 120) return 6; // sea
      if (y > coast) return 7; // beach
      if ((x + 3 * y) % 400 < 8) return 1; // roads
      if (x > 1400 && x < 1700 && y > 150 && y < 400) return 2; // a town
      return 5; // land
    },
  });
}

function panelImage() {
  const w = 600;
  const h = 3000;
  return png({
    width: w,
    height: h,
    colorType: 3,
    palette: PAL,
    pixel: (x, y) => {
      const cell = Math.floor(y / 750);
      const inGutter = y % 750 < 30 || x < 30 || x >= w - 30;
      if (inGutter) return 1;
      return [3, 4, 2, 5][cell];
    },
  });
}

function iconImage() {
  return png({
    width: 24,
    height: 24,
    colorType: 3,
    palette: PAL,
    pixel: (x, y) => ((x - 12) ** 2 + (y - 12) ** 2 < 100 ? 4 : 0),
  });
}

function noAttrsImage() {
  return png({
    width: 800,
    height: 500,
    colorType: 3,
    palette: PAL,
    pixel: (x, y) => (x < 20 || y < 20 || x >= 780 || y >= 480 ? 1 : Math.floor((x + y) / 100) % 2 ? 3 : 6),
  });
}

/** White background, black lines: what a scanned diagram looks like. */
function diagramImage() {
  const w = 1200;
  const h = 800;
  return png({
    width: w,
    height: h,
    colorType: 0,
    pixel: (x, y) => {
      const box = (x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - x0 < 4 || x1 - x < 4 || y - y0 < 4 || y1 - y < 4);
      if (box(100, 100, 400, 250) || box(800, 100, 1100, 250) || box(450, 500, 750, 650)) return 0;
      if (y >= 174 && y < 178 && x >= 400 && x <= 800) return 0; // arrow
      if (x >= 598 && x < 602 && y >= 250 && y <= 500) return 0;
      return 255;
    },
  });
}

function badgeImage() {
  return png({
    width: 400,
    height: 400,
    colorType: 6,
    pixel: (x, y) => {
      const d = Math.hypot(x - 200, y - 200);
      if (d > 190) return [0, 0, 0, 0];
      if (d > 170) return [30, 34, 48, 255];
      return [196, 64, 52, d > 100 ? 255 : 160];
    },
  });
}

function coverImage() {
  return png({
    width: 600,
    height: 900,
    colorType: 3,
    palette: PAL,
    pixel: (x, y) => (x < 24 || y < 24 || x >= 576 || y >= 876 ? 4 : y > 300 && y < 600 && x > 100 && x < 500 ? 2 : 1),
  });
}

const FIGURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240"><rect width="400" height="240" fill="#faf6eb"/><circle cx="120" cy="120" r="70" fill="#3470b0"/><rect x="220" y="60" width="140" height="120" fill="#c44034"/><path d="M20 220 L380 220" stroke="#1e2230" stroke-width="4"/></svg>`;

// ---- animated GIF (two frames, LZW with a clear code before every pixel run) -----------

function lzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const bits = [];
  const out = [];
  let acc = 0;
  let n = 0;
  const emit = (code, size) => {
    acc |= code << n;
    n += size;
    while (n >= 8) {
      out.push(acc & 255);
      acc >>= 8;
      n -= 8;
    }
  };
  void bits;
  // Re-clearing every few codes keeps the code size fixed at minCodeSize + 1 (no dictionary growth to track).
  const size = minCodeSize + 1;
  let count = 0;
  emit(clear, size);
  for (const index of indices) {
    emit(index, size);
    if (++count % (clear - 2) === 0) emit(clear, size);
  }
  emit(eoi, size);
  if (n > 0) out.push(acc & 255);
  return Buffer.from(out);
}

function subBlocks(data) {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) {
    const slice = data.subarray(i, i + 255);
    parts.push(Buffer.from([slice.length]), slice);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function spinnerGif() {
  const size = 64;
  const palette = [
    [250, 246, 235],
    [30, 34, 48],
    [196, 64, 52],
    [52, 110, 176],
  ];
  const header = Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from([size, 0, size, 0, 0xf1, 0, 0]), // 4-colour global table
    Buffer.from(palette.flat()),
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('NETSCAPE2.0', 'ascii'),
    Buffer.from([3, 1, 0, 0, 0]), // loop forever
  ]);
  const frame = (colour) => {
    const pixels = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pixels[y * size + x] = Math.hypot(x - 32, y - 32) < 24 ? colour : 0;
    return Buffer.concat([
      Buffer.from([0x21, 0xf9, 4, 0, 50, 0, 0, 0]), // 0.5 s per frame
      Buffer.from([0x2c, 0, 0, 0, 0, size, 0, size, 0, 0]),
      Buffer.from([2]),
      subBlocks(lzw(pixels, 2)),
    ]);
  };
  return Buffer.concat([header, frame(2), frame(3), Buffer.from([0x3b])]);
}

// ---- the book ---------------------------------------------------------------------------

const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LOREM = 'The caravan reached the ridge at dusk, and from there the whole valley lay open beneath them: the river, the long road, the lamps of the town coming on one by one.';

const images = {
  'cover.png': { data: coverImage(), type: 'image/png', cover: true },
  'huge.png': { data: hugeImage(), type: 'image/png' },
  'map.png': { data: mapImage(), type: 'image/png' },
  'panel.png': { data: panelImage(), type: 'image/png' },
  'icon.png': { data: iconImage(), type: 'image/png' },
  'noattrs.png': { data: noAttrsImage(), type: 'image/png' },
  'diagram.png': { data: diagramImage(), type: 'image/png' },
  'figure.svg': { data: Buffer.from(FIGURE_SVG), type: 'image/svg+xml' },
  'spinner.gif': { data: spinnerGif(), type: 'image/gif' },
  'badge.png': { data: badgeImage(), type: 'image/png' },
};

const chapters = [
  {
    title: 'Large pictures',
    body: `<p>${LOREM}</p>
<p>A 4000 x 6000 picture (it must be shown at the width of the page, never wider, and must not make the text jump while it loads):</p>
<img src="images/huge.png" alt="Huge flat-colour poster" width="4000" height="6000"/>
<p>${LOREM}</p>
<p>A wide map (3200 x 1000). Tap it, then pinch and pan:</p>
<img src="images/map.png" alt="Wide coastal map" width="3200" height="1000"/>
<p>${LOREM}</p>
<p>A tall panel (600 x 3000). It is never taller than 82% of the screen in the page, and shows whole in the lightbox:</p>
<img src="images/panel.png" alt="Tall four-panel strip" width="600" height="3000"/>
<p>${LOREM}</p>`,
  },
  {
    title: 'Small, plain and special pictures',
    body: `<p>A tiny decorative icon <img src="images/icon.png" alt="icon" width="24" height="24"/> inside a line of text - tapping it must NOT open the lightbox.</p>
<p>An image with no width or height at all (the app must read its size itself, so nothing jumps):</p>
<img src="images/noattrs.png" alt="Image with no size attributes"/>
<p>A white-background black-line diagram. On the night theme tap it and use "Invert B&amp;W":</p>
<img src="images/diagram.png" alt="Boxes and arrows diagram" width="1200" height="800"/>
<p>An SVG with a viewBox and no width or height:</p>
<img src="images/figure.svg" alt="Vector figure"/>
<p>An animated GIF (it must keep animating):</p>
<img src="images/spinner.gif" alt="Spinning dot" width="64" height="64"/>
<p>A transparent PNG (the page colour must show through the corners):</p>
<img src="images/badge.png" alt="Round badge" width="400" height="400"/>
<p>${esc(LOREM)}</p>`,
  },
];

async function build() {
  const zip = new JSZip();
  const add = (path, data, compression = 'DEFLATE') => zip.file(path, data, { compression, date: FIXED, createFolders: false });

  add('mimetype', 'application/epub+zip', 'STORE');
  add(
    'META-INF/container.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  add('OEBPS/style.css', 'body { margin: 0; } p { margin: 0 0 1em; }');

  const manifest = ['<item id="css" href="style.css" media-type="text/css"/>', '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'];
  const spine = [];
  const toc = [];
  for (const [name, image] of Object.entries(images)) {
    add(`OEBPS/images/${name}`, image.data, image.type === 'image/svg+xml' ? 'DEFLATE' : 'STORE');
    manifest.push(`<item id="img-${name.replace(/\W/g, '-')}" href="images/${name}" media-type="${image.type}"${image.cover ? ' properties="cover-image"' : ''}/>`);
  }
  chapters.forEach((chapter, i) => {
    manifest.push(`<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i}"/>`);
    toc.push(`<li><a href="c${i}.xhtml">${esc(chapter.title)}</a></li>`);
    add(
      `OEBPS/c${i}.xhtml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>${esc(chapter.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><h2>${esc(chapter.title)}</h2>\n${chapter.body}\n</body></html>`,
    );
  });
  add('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${toc.join('')}</ol></nav></body></html>`);
  add(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:vach-sample:images</dc:identifier><dc:title>Images Sample</dc:title><dc:language>en</dc:language></metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`,
  );
  return zip.generateAsync({ type: 'uint8array', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

mkdirSync(outDir, { recursive: true });
const bytes = await build();
writeFileSync(join(outDir, 'images-sample.epub'), bytes);
console.log(`samples/images-sample.epub  ${bytes.length.toLocaleString()} bytes`);
