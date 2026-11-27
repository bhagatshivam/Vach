// The EPUB image pipeline: turns an image from the archive into a blob: URL
// the reader can show, with its size known up front, and downscales big ones in
// the background.
//
//  1. register() - synchronous, during chapter sanitization. Sniffs the header
//     (imageSniff.ts) so the <img> can be stamped with width, height and an
//     aspect-ratio before it mounts. Images that need no work get a blob: URL
//     of their original bytes right away. Images wider than the screen can use
//     get a tiny placeholder URL instead - the original is NOT turned into a
//     blob - and are downscaled later.
//  2. process() - in the background, at most two at a time, only for images
//     the reader asks about (near the viewport): re-reads the original from the
//     archive, decodes and downsizes it (createImageBitmap + OffscreenCanvas),
//     and hands back the URL of the smaller blob. Any failure falls back to the
//     original bytes; nothing here throws into the reader.
//  3. full() - for the lightbox: decodes the original again at up to 4096 px
//     on the longest side, and gives back a handle whose release() frees it.
//
// The original bytes are never kept: only a function that re-reads the archive
// entry. Every blob: URL the store makes is revoked by revokeAll() when the book
// closes (and the same helper is what per-chapter cleanup will use later).

import { sniffImage, type ImageHeader } from './imageSniff';

const MIB = 1024 * 1024;

/** Background downscales running at once, so a chapter full of images can't freeze the UI. */
export const DOWNSCALE_CONCURRENCY = 2;
/** Widest an image is ever kept for display, in device pixels. */
export const MAX_DISPLAY_WIDTH_PX = 1600;
/** Longest side the lightbox will decode, in pixels. */
export const LIGHTBOX_MAX_SIDE_PX = 4096;
/** Beyond this many pixels an image is not decoded at all (it would not fit in memory): passed through as it is. */
export const MAX_DECODE_PIXELS = 120_000_000;
/** Largest image the reader will take from an archive (matches epub.ts). */
export const MAX_IMAGE_BYTES = 20 * MIB;

// ---------------------------------------------------------------------------
// Which blob: URLs are ours
// ---------------------------------------------------------------------------

// The sanitizer lets an <img src> through only if it is one of these. A book
// cannot name a blob: URL it was not handed, so this is not a way in.
const ownBlobUrls = new Set<string>();

/** Is `url` a blob: URL this app created and has not revoked? A #fragment (used to tell placeholders apart) is ignored. */
export function isOwnBlobUrl(url: string): boolean {
  return ownBlobUrls.has(url.split('#')[0]);
}

// ---------------------------------------------------------------------------
// Decisions (pure)
// ---------------------------------------------------------------------------

/** The widest an image needs to be, in pixels: the screen it is shown on, capped. */
export function displayWidthCap(viewportCssPx: number, devicePixelRatio: number): number {
  return Math.max(1, Math.round(Math.min(viewportCssPx * Math.max(1, devicePixelRatio), MAX_DISPLAY_WIDTH_PX)));
}

export interface ResizePlan {
  width: number;
  height: number;
  /** MIME type to encode: PNG when the image has transparency, otherwise WebP (JPEG if the browser cannot encode WebP). */
  type: 'image/png' | 'image/webp';
  quality: number;
}

/** Whether this kind of image is ever decoded and re-encoded. SVG and animated images pass through. */
function canResample(header: ImageHeader): boolean {
  return header.format !== 'svg' && !header.animated && header.width * header.height <= MAX_DECODE_PIXELS;
}

function outputType(header: ImageHeader): ResizePlan['type'] {
  return header.hasAlpha ? 'image/png' : 'image/webp';
}

/**
 * How to shrink an image for display, or null if it should be left as it is:
 * only images WIDER than the cap are touched, and never SVG, animated or
 * oversized-to-decode ones.
 */
export function planDownscale(header: ImageHeader, widthCap: number): ResizePlan | null {
  if (!canResample(header) || header.width <= widthCap) return null;
  return {
    width: widthCap,
    height: Math.max(1, Math.round((header.height * widthCap) / header.width)),
    type: outputType(header),
    quality: header.format === 'jpeg' ? 0.85 : 0.9,
  };
}

/** How to decode the original for the lightbox: capped on the LONGEST side, or null to use the original bytes. */
export function planFullDecode(header: ImageHeader, maxSide = LIGHTBOX_MAX_SIDE_PX): ResizePlan | null {
  const longest = Math.max(header.width, header.height);
  if (!canResample(header) || longest <= maxSide) return null;
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(header.width * scale)),
    height: Math.max(1, Math.round(header.height * scale)),
    type: outputType(header),
    quality: 0.92,
  };
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/** Runs async tasks, at most `limit` at a time, in the order they were added. */
export class TaskQueue {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running++;
        task().then(resolve, reject).finally(() => {
          this.running--;
          this.waiting.shift()?.();
        });
      };
      if (this.running < this.limit) start();
      else this.waiting.push(start);
    });
  }
}

// ---------------------------------------------------------------------------
// Browser plumbing (injectable, so it can be tested without a browser)
// ---------------------------------------------------------------------------

export interface ImageDeps {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** Decode `bytes` and re-encode it at plan.width x plan.height. May throw. */
  resample(bytes: Uint8Array, header: ImageHeader, plan: ResizePlan): Promise<Blob>;
  viewport(): { width: number; height: number; devicePixelRatio: number };
}

async function browserResample(bytes: Uint8Array, header: ImageHeader, plan: ResizePlan): Promise<Blob> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    throw new Error('Image decoding is not available here');
  }
  const source = new Blob([bytes as BlobPart], { type: header.mime });
  // Decode straight to the target size where possible (no full-size bitmap in
  // memory). A photo turned a quarter by its EXIF flag takes the plain path:
  // browsers disagree about whether resize happens before or after the turn.
  const resizeDirect = header.orientation < 5;
  const bitmap = await createImageBitmap(
    source,
    resizeDirect
      ? { imageOrientation: 'from-image', resizeWidth: plan.width, resizeHeight: plan.height, resizeQuality: 'high' }
      : { imageOrientation: 'from-image' },
  );
  try {
    const canvas = new OffscreenCanvas(plan.width, plan.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D canvas context');
    context.drawImage(bitmap, 0, 0, plan.width, plan.height);
    let blob = await canvas.convertToBlob({ type: plan.type, quality: plan.quality });
    // A browser that cannot encode WebP quietly hands back PNG; use JPEG instead for opaque images.
    if (plan.type === 'image/webp' && blob.type !== 'image/webp') blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: plan.quality });
    return blob;
  } finally {
    bitmap.close();
  }
}

export const browserDeps: ImageDeps = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  resample: browserResample,
  viewport: () => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 }),
};

// 1x1 fully transparent PNG: what a not-yet-downscaled image shows.
const TRANSPARENT_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** Re-reads the original bytes of an image from where they came from (an archive entry). */
export interface ImageSource {
  read(): Promise<Uint8Array>;
}

export interface RegisteredImage {
  /** What to put in <img src>. */
  url: string;
  /** Intrinsic size, when the header could be read (display orientation). */
  width?: number;
  height?: number;
}

export interface FullImage {
  url: string;
  width: number;
  height: number;
  /** Frees the decoded copy. Safe to call more than once. */
  release(): void;
}

interface Entry {
  id: number;
  /** The key it was registered under (a book path), to forget it again. */
  path: string;
  source: ImageSource;
  header: ImageHeader | null;
  mime: string;
  /** The src currently put in HTML for this image. */
  src: string;
  /** Set once a downscaled (or fallback) URL exists. */
  finalUrl?: string;
  plan: ResizePlan | null;
  job?: Promise<string | null>;
  /** Mounted chapters (and the lightbox) currently using this image; see ImageStore.hold(). */
  holds: number;
  /** Has anyone ever held it? Only an image that was held and then let go of is released; one nobody mounted yet is left alone. */
  everHeld: boolean;
  dropTimer?: ReturnType<typeof setTimeout>;
  /** Released: its blob: URLs are revoked and a downscale still in flight must not make a new one. */
  dropped: boolean;
}

export interface ImageStoreOptions {
  /**
   * How long an image nobody holds any more is kept before it is released. A chapter that unmounts in the same
   * commit that another mounts (both showing a shared picture) must not pull it out from under the newcomer, whose
   * HTML already names it. Tests pass 0.
   */
  dropGraceMs?: number;
}

/** Long enough for any chapter that was loaded alongside the one that let go to have mounted and taken its hold. */
export const DEFAULT_DROP_GRACE_MS = 1500;

export class ImageStore {
  private readonly deps: ImageDeps;
  private readonly queue = new TaskQueue(DOWNSCALE_CONCURRENCY);
  private readonly byPath = new Map<string, Entry>();
  private readonly bySrc = new Map<string, Entry>();
  private readonly created = new Set<string>();
  private placeholderBase: string | null = null;
  private nextId = 1;
  private closed = false;
  private readonly dropGraceMs: number;

  constructor(deps: ImageDeps = browserDeps, options: ImageStoreOptions = {}) {
    this.deps = deps;
    this.dropGraceMs = options.dropGraceMs ?? DEFAULT_DROP_GRACE_MS;
  }

  /**
   * Registers an image whose bytes are in hand and returns what the HTML needs:
   * a src and, if the header could be read, its size. Same `path` twice gives the
   * same answer. Never throws.
   */
  register(path: string, bytes: Uint8Array, mediaTypeHint: string, source: ImageSource): RegisteredImage {
    const known = this.byPath.get(path);
    if (known) return this.describeEntry(known);

    const header = sniffImage(bytes);
    const mime = header?.mime ?? (mediaTypeHint.startsWith('image/') ? mediaTypeHint : 'application/octet-stream');
    const { width, devicePixelRatio } = this.deps.viewport();
    // The width the picture is shown at now. (An image prepared in portrait stays that size if the phone is
    // turned; tapping it opens the full-detail copy.)
    const plan = header ? planDownscale(header, displayWidthCap(width, devicePixelRatio)) : null;

    const entry: Entry = { id: this.nextId++, path, source, header, mime, src: '', plan, holds: 0, everHeld: false, dropped: false };
    if (plan) {
      entry.src = `${this.placeholder()}#vach-${entry.id}`;
    } else {
      entry.src = this.makeUrl(new Blob([bytes as BlobPart], { type: mime }));
      entry.finalUrl = entry.src;
    }
    this.byPath.set(path, entry);
    this.bySrc.set(entry.src, entry);
    return this.describeEntry(entry);
  }

  private describeEntry(entry: Entry): RegisteredImage {
    return { url: entry.src, width: entry.header?.width, height: entry.header?.height };
  }

  /** What register() answered for `path`, if the image is still registered (not yet released); null otherwise. */
  known(path: string): RegisteredImage | null {
    const entry = this.byPath.get(path);
    return entry ? this.describeEntry(entry) : null;
  }

  /**
   * Marks the images behind these srcs (as put in HTML, or already downscaled) as in use by one more holder: a chapter
   * that is mounted, the lightbox that is showing one. An image is released - its blob: URLs revoked, its entry
   * forgotten, so a later register() of the same path starts afresh - once every holder has let go. Returns the function
   * that lets go (safe to call twice). Srcs that are not ours are ignored.
   */
  hold(srcs: Iterable<string>): () => void {
    const held: Entry[] = [];
    for (const src of srcs) {
      const entry = this.bySrc.get(src);
      if (!entry || entry.dropped || held.includes(entry)) continue;
      entry.holds++;
      entry.everHeld = true;
      if (entry.dropTimer !== undefined) {
        clearTimeout(entry.dropTimer);
        entry.dropTimer = undefined;
      }
      held.push(entry);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const entry of held) {
        entry.holds--;
        if (entry.holds > 0 || entry.dropped) continue;
        if (this.dropGraceMs <= 0) this.drop(entry);
        else entry.dropTimer = setTimeout(() => this.drop(entry), this.dropGraceMs);
      }
    };
  }

  private drop(entry: Entry): void {
    entry.dropTimer = undefined;
    if (entry.dropped || entry.holds > 0 || this.closed) return;
    entry.dropped = true;
    if (this.byPath.get(entry.path) === entry) this.byPath.delete(entry.path);
    this.bySrc.delete(entry.src);
    if (entry.finalUrl) this.bySrc.delete(entry.finalUrl);
    // Its own blob: URLs only: the shared placeholder (a #fragment of one base URL) stays.
    for (const url of new Set([entry.src.split('#')[0] === this.placeholderBase ? '' : entry.src, entry.finalUrl ?? ''])) {
      if (url && this.created.delete(url)) {
        ownBlobUrls.delete(url);
        this.deps.revokeObjectURL(url);
      }
    }
  }

  /** What the reader knows about an image it is showing, by its current src; null if it is not one of ours. */
  describe(src: string): { width?: number; height?: number; format?: string } | null {
    const entry = this.bySrc.get(src);
    return entry ? { width: entry.header?.width, height: entry.header?.height, format: entry.header?.format } : null;
  }

  /** Has this src (as put in HTML) already been replaced by its downscaled version? */
  currentUrl(src: string): string {
    return this.bySrc.get(src)?.finalUrl ?? src;
  }

  /** Does this src still need its background downscale? */
  isPending(src: string): boolean {
    const entry = this.bySrc.get(src);
    return Boolean(entry && !entry.finalUrl);
  }

  /**
   * Downscales the image behind `src` (a placeholder from register()) and
   * resolves to the URL to show instead. On any failure the original bytes are
   * used instead; resolves to null only if even those cannot be read, or the
   * book was closed meanwhile. Concurrent and repeated calls share one job.
   */
  process(src: string): Promise<string | null> {
    const entry = this.bySrc.get(src);
    if (!entry) return Promise.resolve(null);
    if (entry.finalUrl) return Promise.resolve(entry.finalUrl);
    entry.job ??= this.queue.run(() => this.downscale(entry));
    return entry.job;
  }

  private async downscale(entry: Entry): Promise<string | null> {
    let bytes: Uint8Array;
    try {
      bytes = await entry.source.read();
    } catch (error) {
      console.error('[images] could not re-read an image from the archive', error);
      return null;
    }
    if (this.closed || entry.dropped) return null;

    let blob: Blob;
    try {
      if (!entry.header || !entry.plan) throw new Error('nothing to resample');
      blob = await this.deps.resample(bytes, entry.header, entry.plan);
    } catch (error) {
      // Decoding failed or is unsupported: show the original, as before.
      console.error('[images] downscale failed, using the original', error);
      blob = new Blob([bytes as BlobPart], { type: entry.mime });
    }
    // The chapter was unmounted (and the picture released) while it was being resampled: no URL for nobody.
    if (this.closed || entry.dropped) return null;
    entry.finalUrl = this.makeUrl(blob);
    this.bySrc.set(entry.finalUrl, entry);
    return entry.finalUrl;
  }

  /**
   * The original at full detail for the lightbox, capped at 4096 px on the
   * longest side. The decoded copy is the caller's to release(). Resolves to
   * null if the image cannot be read.
   */
  async full(src: string): Promise<FullImage | null> {
    const entry = this.bySrc.get(src);
    if (!entry || this.closed) return null;
    let bytes: Uint8Array;
    try {
      bytes = await entry.source.read();
    } catch (error) {
      console.error('[images] could not read the original for the lightbox', error);
      return null;
    }

    const header = entry.header;
    const plan = header ? planFullDecode(header) : null;
    let blob = new Blob([bytes as BlobPart], { type: entry.mime });
    let width = header?.width ?? 0;
    let height = header?.height ?? 0;
    if (header && plan) {
      try {
        blob = await this.deps.resample(bytes, header, plan);
        width = plan.width;
        height = plan.height;
      } catch (error) {
        console.error('[images] full-detail decode failed, using the original', error);
      }
    }
    if (this.closed) return null;

    const url = this.deps.createObjectURL(blob);
    this.created.add(url);
    let released = false;
    return {
      url,
      width,
      height,
      release: () => {
        if (released) return;
        released = true;
        // revokeAll() may already have freed it (the book closed while the lightbox was open).
        if (this.created.delete(url)) this.deps.revokeObjectURL(url);
      },
    };
  }

  private placeholder(): string {
    this.placeholderBase ??= this.makeUrl(new Blob([TRANSPARENT_PNG as BlobPart], { type: 'image/png' }));
    return this.placeholderBase;
  }

  private makeUrl(blob: Blob): string {
    const url = this.deps.createObjectURL(blob);
    this.created.add(url);
    ownBlobUrls.add(url);
    return url;
  }

  /** Revokes every blob: URL this store made. After this the store gives out nothing more. */
  revokeAll(): void {
    this.closed = true;
    for (const entry of this.bySrc.values()) {
      if (entry.dropTimer !== undefined) clearTimeout(entry.dropTimer);
    }
    for (const url of this.created) {
      ownBlobUrls.delete(url);
      this.deps.revokeObjectURL(url);
    }
    this.created.clear();
    this.byPath.clear();
    this.bySrc.clear();
    this.placeholderBase = null;
  }

  /** How many blob: URLs are live (for tests and diagnostics). */
  get liveUrlCount(): number {
    return this.created.size;
  }
}
