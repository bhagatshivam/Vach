import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOWNSCALE_CONCURRENCY,
  ImageStore,
  LIGHTBOX_MAX_SIDE_PX,
  MAX_DECODE_PIXELS,
  MAX_DISPLAY_WIDTH_PX,
  TaskQueue,
  displayWidthCap,
  isOwnBlobUrl,
  planDownscale,
  planFullDecode,
  type ImageDeps,
} from './imageProcessor';
import type { ImageHeader } from './imageSniff';

// ---- fixtures ------------------------------------------------------------------

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function pngBytes(width: number, height: number, colorType = 2, animated = false): Uint8Array {
  const chunk = (type: string, data: number[]) => [...be32(data.length), ...type.split('').map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...be32(width), ...be32(height), 8, colorType, 0, 0, 0]),
    ...(animated ? chunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]) : []),
    ...chunk('IDAT', [0, 0, 0, 0]),
  ]);
}
const header = (over: Partial<ImageHeader> = {}): ImageHeader => ({ format: 'png', mime: 'image/png', width: 4000, height: 6000, hasAlpha: false, animated: false, orientation: 1, ...over });

/** Deps that record everything: URLs made and revoked, resamples asked for, and how many ran at once. */
function fakeDeps(options: { width?: number; height?: number; dpr?: number; resample?: ImageDeps['resample'] } = {}) {
  let counter = 0;
  const made = new Map<string, Blob>();
  const revoked: string[] = [];
  const resamples: Array<{ plan: { width: number; height: number; type: string; quality: number }; bytes: Uint8Array }> = [];
  let running = 0;
  let maxRunning = 0;
  const deps: ImageDeps = {
    createObjectURL: (blob) => {
      const url = `blob:http://localhost/${++counter}`;
      made.set(url, blob);
      return url;
    },
    revokeObjectURL: (url) => {
      revoked.push(url);
    },
    resample:
      options.resample ??
      (async (bytes, _header, plan) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        resamples.push({ plan, bytes });
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return new Blob([`resampled-${plan.width}x${plan.height}`], { type: plan.type });
      }),
    viewport: () => ({ width: options.width ?? 400, height: options.height ?? 800, devicePixelRatio: options.dpr ?? 2 }),
  };
  return { deps, made, revoked, resamples, maxRunning: () => maxRunning };
}

const source = (bytes: Uint8Array) => ({ read: vi.fn(async () => bytes) });

afterEach(() => vi.restoreAllMocks());

// ---- decisions -------------------------------------------------------------------

describe('displayWidthCap', () => {
  it('is the screen in device pixels, capped at 1600', () => {
    expect(displayWidthCap(360, 2)).toBe(720);
    expect(displayWidthCap(412, 2.625)).toBe(1082);
    expect(displayWidthCap(800, 3)).toBe(MAX_DISPLAY_WIDTH_PX);
    expect(MAX_DISPLAY_WIDTH_PX).toBe(1600);
  });

  it('treats a pixel ratio below 1 as 1 and never returns less than 1', () => {
    expect(displayWidthCap(360, 0.5)).toBe(360);
    expect(displayWidthCap(0, 1)).toBe(1);
  });
});

describe('planDownscale', () => {
  it('shrinks an image wider than the cap to the cap, keeping its proportions', () => {
    const plan = planDownscale(header({ width: 4000, height: 6000 }), 1000)!;
    expect(plan.width).toBe(1000);
    expect(plan.height).toBe(1500);
  });

  it('leaves an image that is not wider than the cap alone (including exactly the cap)', () => {
    expect(planDownscale(header({ width: 1000, height: 5000 }), 1000)).toBeNull();
    expect(planDownscale(header({ width: 999, height: 5000 }), 1000)).toBeNull();
    expect(planDownscale(header({ width: 1001, height: 5000 }), 1000)).not.toBeNull();
  });

  it('a tall image is judged by its width only', () => {
    expect(planDownscale(header({ width: 800, height: 20000 }), 1000)).toBeNull();
  });

  it('never rounds the height to zero', () => {
    expect(planDownscale(header({ width: 100000, height: 1 }), 1000)!.height).toBe(1);
  });

  it('keeps transparency (PNG out), otherwise WebP', () => {
    expect(planDownscale(header({ hasAlpha: true }), 1000)!.type).toBe('image/png');
    expect(planDownscale(header({ hasAlpha: false }), 1000)!.type).toBe('image/webp');
  });

  it('never touches SVG, or anything animated (GIF, APNG, animated WebP)', () => {
    expect(planDownscale(header({ format: 'svg', mime: 'image/svg+xml' }), 100)).toBeNull();
    expect(planDownscale(header({ format: 'gif', mime: 'image/gif', animated: true }), 100)).toBeNull();
    expect(planDownscale(header({ animated: true }), 100)).toBeNull();
  });

  it('a still GIF is fine to downscale', () => {
    expect(planDownscale(header({ format: 'gif', mime: 'image/gif', animated: false }), 100)).not.toBeNull();
  });

  it('passes through an image too large to decode at all', () => {
    expect(planDownscale(header({ width: 20000, height: 20000 }), 1000)).toBeNull();
    expect(20000 * 20000).toBeGreaterThan(MAX_DECODE_PIXELS);
    expect(planDownscale(header({ width: 10000, height: 10000 }), 1000)).not.toBeNull(); // 100 MP: still decodable
  });
});

describe('planFullDecode (the lightbox)', () => {
  it('caps the LONGEST side at 4096, keeping proportions', () => {
    expect(LIGHTBOX_MAX_SIDE_PX).toBe(4096);
    expect(planFullDecode(header({ width: 4000, height: 6000 }))).toMatchObject({ width: 2731, height: 4096 });
    expect(planFullDecode(header({ width: 8000, height: 2000 }))).toMatchObject({ width: 4096, height: 1024 });
  });

  it('uses the original bytes as they are when nothing is over the cap', () => {
    expect(planFullDecode(header({ width: 4096, height: 4096 }))).toBeNull();
    expect(planFullDecode(header({ width: 1200, height: 900 }))).toBeNull();
  });

  it('passes SVG and animated images through at any size', () => {
    expect(planFullDecode(header({ format: 'svg', width: 9000, height: 9000 }))).toBeNull();
    expect(planFullDecode(header({ animated: true, width: 9000, height: 9000 }))).toBeNull();
  });
});

describe('TaskQueue', () => {
  it('never runs more than the limit at once, and runs everything in order of arrival', async () => {
    const queue = new TaskQueue(2);
    let running = 0;
    let max = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        queue.run(async () => {
          running++;
          max = Math.max(max, running);
          order.push(i);
          await new Promise((resolve) => setTimeout(resolve, 3));
          running--;
        }),
      ),
    );
    expect(max).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('a failing task does not stall the ones behind it', async () => {
    const queue = new TaskQueue(1);
    const results = await Promise.allSettled([queue.run(async () => 'a'), queue.run(async () => Promise.reject(new Error('x'))), queue.run(async () => 'c')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});

// ---- the store -----------------------------------------------------------------------

describe('ImageStore.register', () => {
  it('an image that needs no work gets a blob: URL of its original bytes right away, and its size', () => {
    const { deps, made } = fakeDeps(); // cap = min(400 * 2, 1600) = 800
    const store = new ImageStore(deps);
    const bytes = pngBytes(800, 1200); // exactly the cap: left alone
    const info = store.register('a.png', bytes, 'image/png', source(bytes));
    expect(info).toMatchObject({ width: 800, height: 1200 });
    expect(info.url).toMatch(/^blob:/);
    expect(made.get(info.url)?.size).toBe(bytes.length);
    expect(store.isPending(info.url)).toBe(false);
    expect(isOwnBlobUrl(info.url)).toBe(true);
  });

  it('an image wider than the screen needs gets a placeholder, NOT a blob of the original', () => {
    const { deps, made } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = pngBytes(4000, 6000);
    const info = store.register('big.png', bytes, 'image/png', source(bytes));
    expect(info.width).toBe(4000);
    expect(info.height).toBe(6000);
    expect(info.url).toMatch(/^blob:http:\/\/localhost\/\d+#vach-\d+$/);
    expect(store.isPending(info.url)).toBe(true);
    // The only blob created is the shared 1x1 placeholder - the original is not kept alive as a blob.
    expect(made.size).toBe(1);
    expect(Array.from(made.values())[0].size).toBeLessThan(200);
  });

  it('follows the width the page is shown at, in device pixels', () => {
    const { deps } = fakeDeps({ width: 400, height: 1100, dpr: 1 }); // cap 400
    const store = new ImageStore(deps);
    const wide = pngBytes(401, 700);
    const fits = pngBytes(400, 700);
    expect(store.isPending(store.register('wide.png', wide, 'image/png', source(wide)).url)).toBe(true);
    expect(store.isPending(store.register('fits.png', fits, 'image/png', source(fits)).url)).toBe(false);
  });

  it('shares one placeholder blob between images, told apart by a #fragment', () => {
    const { deps, made } = fakeDeps();
    const store = new ImageStore(deps);
    const a = pngBytes(3000, 100);
    const b = pngBytes(3000, 200);
    const first = store.register('a.png', a, 'image/png', source(a));
    const second = store.register('b.png', b, 'image/png', source(b));
    expect(made.size).toBe(1);
    expect(first.url.split('#')[0]).toBe(second.url.split('#')[0]);
    expect(first.url).not.toBe(second.url);
  });

  it('the same path twice is the same image', () => {
    const { deps, made } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = pngBytes(100, 100);
    const one = store.register('a.png', bytes, 'image/png', source(bytes));
    const two = store.register('a.png', bytes, 'image/png', source(bytes));
    expect(two).toEqual(one);
    expect(made.size).toBe(1);
  });

  it('an unrecognised format is still shown (blob with the manifest type), just without a size', () => {
    const { deps, made } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = Uint8Array.of(1, 2, 3, 4, 5);
    const info = store.register('x.avif', bytes, 'image/avif', source(bytes));
    expect(info.width).toBeUndefined();
    expect(info.height).toBeUndefined();
    expect(made.get(info.url)?.type).toBe('image/avif');
  });

  it('SVG and animated images pass straight through, whatever their size', () => {
    const { deps } = fakeDeps();
    const store = new ImageStore(deps);
    const svg = new TextEncoder().encode('<svg viewBox="0 0 9000 9000"></svg>');
    const apng = pngBytes(9000, 9000, 6, true);
    expect(store.isPending(store.register('a.svg', svg, 'image/svg+xml', source(svg)).url)).toBe(false);
    expect(store.isPending(store.register('b.png', apng, 'image/png', source(apng)).url)).toBe(false);
  });

  it('does not read the archive entry again just by registering (it keeps a way to, not the bytes)', () => {
    const { deps } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = pngBytes(4000, 6000);
    const src = source(bytes);
    store.register('big.png', bytes, 'image/png', src);
    expect(src.read).not.toHaveBeenCalled();
  });

  it('describe() reports size and format for its own URLs, and null for anything else', () => {
    const { deps } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = pngBytes(640, 480);
    const info = store.register('a.png', bytes, 'image/png', source(bytes));
    expect(store.describe(info.url)).toEqual({ width: 640, height: 480, format: 'png' });
    expect(store.describe('blob:http://localhost/other')).toBeNull();
  });
});

describe('ImageStore.process (the background downscale)', () => {
  it('re-reads the original, resamples to the planned size, and returns a new URL; the placeholder is never revoked early', async () => {
    const { deps, resamples, made } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = pngBytes(4000, 6000);
    const src = source(bytes);
    const info = store.register('big.png', bytes, 'image/png', src);

    const url = await store.process(info.url);
    expect(src.read).toHaveBeenCalledTimes(1);
    expect(resamples).toHaveLength(1);
    expect(resamples[0].plan).toMatchObject({ width: 800, height: 1200, type: 'image/webp' });
    expect(url).toMatch(/^blob:/);
    expect(url).not.toBe(info.url);
    expect(made.get(url!)?.type).toBe('image/webp');
    expect(isOwnBlobUrl(url!)).toBe(true);
    expect(store.currentUrl(info.url)).toBe(url);
    expect(store.isPending(info.url)).toBe(false);
  });

  it('concurrent and repeated requests for one image share one job', async () => {
    const { deps, resamples } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = pngBytes(4000, 6000);
    const src = source(bytes);
    const info = store.register('big.png', bytes, 'image/png', src);
    const [a, b] = await Promise.all([store.process(info.url), store.process(info.url)]);
    const c = await store.process(info.url);
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(resamples).toHaveLength(1);
    expect(src.read).toHaveBeenCalledTimes(1);
  });

  it(`runs at most ${DOWNSCALE_CONCURRENCY} downscales at a time, however many images are waiting`, async () => {
    const { deps, resamples, maxRunning } = fakeDeps();
    const store = new ImageStore(deps);
    const urls = Array.from({ length: 8 }, (_, i) => {
      const bytes = pngBytes(3000 + i, 2000);
      return store.register(`p${i}.png`, bytes, 'image/png', source(bytes)).url;
    });
    await Promise.all(urls.map((url) => store.process(url)));
    expect(resamples).toHaveLength(8);
    expect(maxRunning()).toBe(2);
  });

  it('falls back to the original bytes when decoding fails, and never throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, made } = fakeDeps({ resample: async () => Promise.reject(new Error('decode error')) });
    const store = new ImageStore(deps);
    const bytes = pngBytes(4000, 6000);
    const info = store.register('big.png', bytes, 'image/png', source(bytes));
    const url = await store.process(info.url);
    expect(url).toMatch(/^blob:/);
    expect(made.get(url!)?.size).toBe(bytes.length); // the original, byte for byte
    expect(made.get(url!)?.type).toBe('image/png');
    spy.mockRestore();
  });

  it('falls back when the browser has no image decoding at all (resample throws synchronously)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = fakeDeps({
      resample: () => {
        throw new Error('Image decoding is not available here');
      },
    });
    const store = new ImageStore(deps);
    const bytes = pngBytes(4000, 6000);
    const info = store.register('big.png', bytes, 'image/png', source(bytes));
    await expect(store.process(info.url)).resolves.toMatch(/^blob:/);
  });

  it('if even the original cannot be re-read, resolves to null and leaves the placeholder (never throws)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = pngBytes(4000, 6000);
    const info = store.register('big.png', bytes, 'image/png', { read: async () => Promise.reject(new Error('archive gone')) });
    await expect(store.process(info.url)).resolves.toBeNull();
    expect(store.isPending(info.url)).toBe(true);
  });

  it('an unknown src is not an error', async () => {
    const { deps } = fakeDeps();
    await expect(new ImageStore(deps).process('blob:http://localhost/nope')).resolves.toBeNull();
  });
});

describe('ImageStore.full (the lightbox)', () => {
  it('uses the original bytes untouched when it is within 4096 px, and release() frees exactly that copy', async () => {
    const { deps, made, revoked, resamples } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = pngBytes(3000, 4000);
    const info = store.register('a.png', bytes, 'image/png', source(bytes));
    const full = (await store.full(info.url))!;
    expect(resamples).toHaveLength(0);
    expect(made.get(full.url)?.size).toBe(bytes.length);
    expect(full).toMatchObject({ width: 3000, height: 4000 });

    full.release();
    full.release(); // idempotent
    expect(revoked.filter((u) => u === full.url)).toHaveLength(1);
  });

  it('decodes an image over 4096 px down to 4096 on its longest side', async () => {
    const { deps, resamples } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = pngBytes(4000, 6000);
    const info = store.register('big.png', bytes, 'image/png', source(bytes));
    const full = (await store.full(info.url))!;
    expect(resamples[0].plan).toMatchObject({ width: 2731, height: 4096 });
    expect(full).toMatchObject({ width: 2731, height: 4096 });
  });

  it('works from the placeholder URL or the downscaled one - either names the same image', async () => {
    const { deps } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = pngBytes(4000, 6000);
    const info = store.register('big.png', bytes, 'image/png', source(bytes));
    const small = (await store.process(info.url))!;
    expect(await store.full(info.url)).not.toBeNull();
    expect(await store.full(small)).not.toBeNull();
  });

  it('falls back to the original if the full-detail decode fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, made } = fakeDeps({ resample: async () => Promise.reject(new Error('oom')) });
    const store = new ImageStore(deps);
    const bytes = pngBytes(4000, 6000);
    const info = store.register('big.png', bytes, 'image/png', source(bytes));
    const full = (await store.full(info.url))!;
    expect(made.get(full.url)?.size).toBe(bytes.length);
  });

  it('is null for something that is not one of its images, or whose original cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = fakeDeps();
    const store = new ImageStore(deps);
    expect(await store.full('blob:http://localhost/nope')).toBeNull();
    const bytes = pngBytes(100, 100);
    const info = store.register('a.png', bytes, 'image/png', { read: async () => Promise.reject(new Error('gone')) });
    expect(await store.full(info.url)).toBeNull();
  });
});

describe('ImageStore.revokeAll (the book closes)', () => {
  it('revokes every blob: URL it ever made - originals, downscaled copies, the placeholder and any full-detail copy still open', async () => {
    const { deps, made, revoked } = fakeDeps();
    const store = new ImageStore(deps);
    const small = pngBytes(500, 500);
    const big = pngBytes(4000, 6000);
    store.register('small.png', small, 'image/png', source(small));
    const bigInfo = store.register('big.png', big, 'image/png', source(big));
    await store.process(bigInfo.url);
    const full = (await store.full(bigInfo.url))!;

    store.revokeAll();
    expect([...made.keys()].sort()).toEqual([...revoked].sort());
    expect(store.liveUrlCount).toBe(0);
    full.release(); // already revoked by revokeAll: must not revoke twice
    expect(revoked.filter((u) => u === full.url)).toHaveLength(1);
  });

  it('after close, the URLs are no longer "own" (so the sanitizer would refuse them)', () => {
    const { deps } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = pngBytes(500, 500);
    const { url } = store.register('a.png', bytes, 'image/png', source(bytes));
    expect(isOwnBlobUrl(url)).toBe(true);
    store.revokeAll();
    expect(isOwnBlobUrl(url)).toBe(false);
  });

  it('a downscale that finishes after close creates nothing', async () => {
    const { deps, made } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = pngBytes(4000, 6000);
    const info = store.register('big.png', bytes, 'image/png', source(bytes));
    const pending = store.process(info.url);
    store.revokeAll();
    expect(await pending).toBeNull();
    // Only the placeholder ever existed.
    expect(made.size).toBe(1);
  });

  it('isOwnBlobUrl ignores a #fragment and rejects look-alikes', () => {
    const { deps } = fakeDeps();
    const store = new ImageStore(deps);
    const bytes = pngBytes(4000, 6000);
    const { url } = store.register('big.png', bytes, 'image/png', source(bytes));
    expect(isOwnBlobUrl(url)).toBe(true);
    expect(isOwnBlobUrl(url.split('#')[0])).toBe(true);
    expect(isOwnBlobUrl('blob:http://localhost/999999')).toBe(false);
    expect(isOwnBlobUrl('http://localhost/1')).toBe(false);
    expect(isOwnBlobUrl('')).toBe(false);
  });
});

// ---- releasing an image when the chapters showing it unmount --------------------------------------------------------

describe('ImageStore.hold (a chapter unmounts: its pictures are released)', () => {
  /** A big picture (it will be downscaled), registered and downscaled, so it has a blob: URL of its own. */
  async function downscaled(store: ImageStore, path: string, bytes = pngBytes(4000, 3000)) {
    const placeholder = store.register(path, bytes, 'image/png', source(bytes)).url;
    const url = await store.process(placeholder);
    return { placeholder, url: url! };
  }

  it('revokes the downscaled blob: URL once the only chapter holding the picture lets go, and forgets the picture', async () => {
    const { deps, revoked } = fakeDeps();
    const store = new ImageStore(deps, { dropGraceMs: 0 });
    const { placeholder, url } = await downscaled(store, 'a.png');
    const letGo = store.hold([placeholder]);
    expect(store.known('a.png')).not.toBeNull();
    expect(store.liveUrlCount).toBe(2); // the shared placeholder and this picture's own

    letGo();
    expect(revoked).toEqual([url]);
    expect(store.liveUrlCount).toBe(1); // only the shared placeholder remains
    expect(store.known('a.png')).toBeNull();
    expect(store.describe(placeholder)).toBeNull();
    expect(store.currentUrl(placeholder)).toBe(placeholder);
    expect(isOwnBlobUrl(url)).toBe(false);
  });

  it('a picture shared by two chapters lives until both have let go', async () => {
    const { deps, revoked } = fakeDeps();
    const store = new ImageStore(deps, { dropGraceMs: 0 });
    const { placeholder, url } = await downscaled(store, 'shared.png');
    const first = store.hold([placeholder]);
    const second = store.hold([url]); // the same picture, by its downscaled src: bySrc knows both
    first();
    expect(revoked).toEqual([]);
    second();
    expect(revoked).toEqual([url]);
  });

  it('letting go twice is harmless', async () => {
    const { deps, revoked } = fakeDeps();
    const store = new ImageStore(deps, { dropGraceMs: 0 });
    const { placeholder } = await downscaled(store, 'a.png');
    const first = store.hold([placeholder]);
    const second = store.hold([placeholder]);
    first();
    first();
    expect(revoked).toEqual([]);
    second();
    expect(revoked).toHaveLength(1);
  });

  it('a picture nobody ever held is left alone (a chapter that was loaded but not mounted yet)', async () => {
    const { deps, revoked } = fakeDeps();
    const store = new ImageStore(deps, { dropGraceMs: 0 });
    await downscaled(store, 'a.png');
    store.hold([]);
    expect(revoked).toEqual([]);
    expect(store.known('a.png')).not.toBeNull();
  });

  it('a small picture (shown as it is, no downscale) has its own blob: URL released too', () => {
    const { deps, revoked } = fakeDeps();
    const store = new ImageStore(deps, { dropGraceMs: 0 });
    const bytes = pngBytes(100, 80);
    const { url } = store.register('icon.png', bytes, 'image/png', source(bytes));
    expect(url.startsWith('blob:')).toBe(true);
    store.hold([url])();
    expect(revoked).toEqual([url]);
    expect(store.known('icon.png')).toBeNull();
  });

  it('a picture registered again after it was released starts afresh, with a src of its own', async () => {
    const { deps } = fakeDeps();
    const store = new ImageStore(deps, { dropGraceMs: 0 });
    const bytes = pngBytes(4000, 3000);
    const first = store.register('a.png', bytes, 'image/png', source(bytes));
    store.hold([first.url])();
    const again = store.register('a.png', bytes, 'image/png', source(bytes));
    expect(again.url).not.toBe(first.url);
    expect(again.width).toBe(4000);
    expect(store.isPending(again.url)).toBe(true);
    expect(await store.process(again.url)).not.toBeNull();
  });

  it('a downscale still running when the chapter unmounts makes no blob: URL for nobody', async () => {
    const release: { go: () => void } = { go: () => {} };
    const { deps, made } = fakeDeps({ resample: () => new Promise((resolve) => (release.go = () => resolve(new Blob(['x'], { type: 'image/webp' })))) });
    const store = new ImageStore(deps, { dropGraceMs: 0 });
    const bytes = pngBytes(4000, 3000);
    const placeholder = store.register('a.png', bytes, 'image/png', source(bytes)).url;
    const letGo = store.hold([placeholder]);
    const job = store.process(placeholder);
    await Promise.resolve();
    letGo();
    await vi.waitFor(() => expect(release.go).toBeTypeOf('function'));
    release.go();
    expect(await job).toBeNull();
    expect(made.size).toBe(1); // only the shared placeholder was ever made
  });

  it('keeps a released picture for a grace period, so a chapter loaded alongside the one that let go can take it over', async () => {
    vi.useFakeTimers();
    try {
      const { deps, revoked } = fakeDeps({ resample: async () => new Blob(['x'], { type: 'image/webp' }) });
      const store = new ImageStore(deps, { dropGraceMs: 1500 });
      const bytes = pngBytes(4000, 3000);
      const placeholder = store.register('a.png', bytes, 'image/png', source(bytes)).url;
      const url = (await store.process(placeholder))!;
      store.hold([placeholder])(); // the chapter unmounts...
      const newcomer = store.hold([placeholder]); // ...in the same commit that another chapter showing it mounts
      await vi.advanceTimersByTimeAsync(5000);
      expect(revoked).toEqual([]);
      expect(store.currentUrl(placeholder)).toBe(url);
      newcomer();
      await vi.advanceTimersByTimeAsync(1499);
      expect(revoked).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      expect(revoked).toEqual([url]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closing the book still revokes everything, including pictures waiting out their grace period', async () => {
    vi.useFakeTimers();
    try {
      const { deps, revoked } = fakeDeps({ resample: async () => new Blob(['x'], { type: 'image/webp' }) });
      const store = new ImageStore(deps, { dropGraceMs: 1500 });
      const bytes = pngBytes(4000, 3000);
      const placeholder = store.register('a.png', bytes, 'image/png', source(bytes)).url;
      await store.process(placeholder);
      store.hold([placeholder])();
      store.revokeAll();
      expect(store.liveUrlCount).toBe(0);
      const count = revoked.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(revoked).toHaveLength(count); // the timer did not revoke anything twice
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores srcs that are not ours', () => {
    const { deps, revoked } = fakeDeps();
    const store = new ImageStore(deps, { dropGraceMs: 0 });
    store.hold(['blob:http://localhost/not-ours', '', 'https://example.com/x.png'])();
    expect(revoked).toEqual([]);
  });
});
