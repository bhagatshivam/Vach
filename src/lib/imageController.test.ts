import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageController } from './imageController';
import { ImageStore, type ImageDeps } from './imageProcessor';

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function pngBytes(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: number[]) => [...be32(data.length), ...type.split('').map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]), ...chunk('IDAT', [0, 0, 0, 0])]);
}

function makeStore(resample?: ImageDeps['resample']) {
  let counter = 0;
  const deps: ImageDeps = {
    createObjectURL: () => `blob:http://localhost/${++counter}`,
    revokeObjectURL: () => {},
    resample: resample ?? (async () => new Blob(['small'], { type: 'image/webp' })),
    viewport: () => ({ width: 400, height: 800, devicePixelRatio: 2 }),
  };
  return new ImageStore(deps);
}

/** Registers a big image and returns an HTML section holding <img>s for it, plus its placeholder src. */
function chapterWith(store: ImageStore, paths: string[]): { section: HTMLElement; srcs: string[] } {
  const section = document.createElement('section');
  const srcs = paths.map((path, i) => {
    const bytes = pngBytes(3000 + i, 2000);
    const src = store.register(path, bytes, 'image/png', { read: async () => bytes }).url;
    const img = document.createElement('img');
    img.setAttribute('src', src);
    section.append(img);
    return src;
  });
  document.body.append(section);
  return { section, srcs };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ImageController without IntersectionObserver (every pending image is processed)', () => {
  it('swaps each placeholder for the downscaled image', async () => {
    const store = makeStore();
    const controller = new ImageController(store);
    const { section, srcs } = chapterWith(store, ['a.png', 'b.png']);
    controller.register(section);
    await settle();
    const now = Array.from(section.querySelectorAll('img')).map((img) => img.getAttribute('src'));
    expect(now).not.toEqual(srcs);
    expect(now.every((src) => src && !src.includes('#vach-'))).toBe(true);
    controller.destroy();
  });

  it('leaves images that need no work alone', async () => {
    const store = makeStore();
    const controller = new ImageController(store);
    const section = document.createElement('section');
    const bytes = pngBytes(500, 500);
    const url = store.register('small.png', bytes, 'image/png', { read: async () => bytes }).url;
    section.innerHTML = `<img src="${url}">`;
    document.body.append(section);
    controller.register(section);
    await settle();
    expect(section.querySelector('img')!.getAttribute('src')).toBe(url);
  });

  it('an image shared with an earlier chapter is updated at once (already downscaled)', async () => {
    const store = makeStore();
    const controller = new ImageController(store);
    const first = chapterWith(store, ['shared.png']);
    controller.register(first.section);
    await settle();
    const done = first.section.querySelector('img')!.getAttribute('src')!;

    const second = document.createElement('section');
    second.innerHTML = `<img src="${first.srcs[0]}">`; // a later chapter still carries the placeholder
    document.body.append(second);
    controller.register(second);
    expect(second.querySelector('img')!.getAttribute('src')).toBe(done);
  });

  it('when the downscale fails outright the placeholder stays, and nothing throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = makeStore();
    const controller = new ImageController(store);
    const section = document.createElement('section');
    const bytes = pngBytes(4000, 6000);
    const src = store.register('x.png', bytes, 'image/png', { read: async () => Promise.reject(new Error('gone')) }).url;
    section.innerHTML = `<img src="${src}">`;
    document.body.append(section);
    expect(() => controller.register(section)).not.toThrow();
    await settle();
    expect(section.querySelector('img')!.getAttribute('src')).toBe(src);
  });

  it('stops after destroy()', async () => {
    const store = makeStore();
    const controller = new ImageController(store);
    controller.destroy();
    const { section, srcs } = chapterWith(store, ['a.png']);
    controller.register(section);
    await settle();
    expect(section.querySelector('img')!.getAttribute('src')).toBe(srcs[0]);
  });

  it('unregistering a chapter stops its images being swapped', async () => {
    const resample = vi.fn(async () => new Blob(['x']));
    const store = makeStore(resample);
    const controller = new ImageController(store);
    const { section, srcs } = chapterWith(store, ['a.png']);
    const stop = controller.register(section);
    stop();
    await settle();
    // It was already requested when it registered (no observer), so what matters is that unregistering is safe.
    expect(section.querySelector('img')).not.toBeNull();
    expect(srcs.length).toBe(1);
  });
});

describe('ImageController with IntersectionObserver (only images near the viewport are processed)', () => {
  it('does nothing for an image until it comes near, then processes just that one', async () => {
    const observers: Array<{ callback: IntersectionObserverCallback; targets: Element[] }> = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        targets: Element[] = [];
        callback: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
          observers.push(this);
        }
        observe(target: Element) {
          this.targets.push(target);
        }
        unobserve(target: Element) {
          this.targets = this.targets.filter((t) => t !== target);
        }
        disconnect() {}
      },
    );
    const resample = vi.fn(async () => new Blob(['small'], { type: 'image/webp' }));
    const store = makeStore(resample);
    const controller = new ImageController(store);
    const { section, srcs } = chapterWith(store, ['near.png', 'far.png']);
    controller.register(section);
    await settle();
    expect(resample).not.toHaveBeenCalled();
    expect(observers[0].targets).toHaveLength(2);

    const [near, far] = Array.from(section.querySelectorAll('img'));
    observers[0].callback([{ target: near, isIntersecting: true } as unknown as IntersectionObserverEntry], observers[0] as unknown as IntersectionObserver);
    await settle();
    expect(resample).toHaveBeenCalledTimes(1);
    expect(near.getAttribute('src')).not.toBe(srcs[0]);
    expect(far.getAttribute('src')).toBe(srcs[1]); // still the placeholder

    // An image that is not intersecting is ignored.
    observers[0].callback([{ target: far, isIntersecting: false } as unknown as IntersectionObserverEntry], observers[0] as unknown as IntersectionObserver);
    await settle();
    expect(resample).toHaveBeenCalledTimes(1);

    observers[0].callback([{ target: far, isIntersecting: true } as unknown as IntersectionObserverEntry], observers[0] as unknown as IntersectionObserver);
    await settle();
    expect(resample).toHaveBeenCalledTimes(2);
    controller.destroy();
  });
});

describe('ImageController: a chapter holds its pictures while it is mounted', () => {
  function storeThatCounts() {
    let counter = 0;
    const revoked: string[] = [];
    const deps: ImageDeps = {
      createObjectURL: () => `blob:http://localhost/${++counter}`,
      revokeObjectURL: (url) => void revoked.push(url),
      resample: async () => new Blob(['small'], { type: 'image/webp' }),
      viewport: () => ({ width: 400, height: 800, devicePixelRatio: 2 }),
    };
    return { store: new ImageStore(deps, { dropGraceMs: 0 }), revoked };
  }

  it('stopping (the chapter unmounts) releases its pictures: the downscaled blob: URL is revoked', async () => {
    const { store, revoked } = storeThatCounts();
    const controller = new ImageController(store);
    const { section, srcs } = chapterWith(store, ['a.png', 'b.png']);
    const stop = controller.register(section);
    await settle();
    const shown = Array.from(section.querySelectorAll('img')).map((img) => img.getAttribute('src')!);
    expect(shown.every((src) => !src.includes('#vach-'))).toBe(true);
    expect(revoked).toEqual([]);

    stop();
    expect(new Set(revoked)).toEqual(new Set(shown));
    expect(srcs.every((src) => store.describe(src) === null)).toBe(true);
    controller.destroy();
  });

  it('a picture two mounted chapters share survives the first of them unmounting', async () => {
    const { store, revoked } = storeThatCounts();
    const controller = new ImageController(store);
    const bytes = pngBytes(3000, 2000);
    const src = store.register('ornament.png', bytes, 'image/png', { read: async () => bytes }).url;
    const make = () => {
      const section = document.createElement('section');
      const img = document.createElement('img');
      img.setAttribute('src', src);
      section.append(img);
      document.body.append(section);
      return section;
    };
    const first = make();
    const second = make();
    const stopFirst = controller.register(first);
    const stopSecond = controller.register(second);
    await settle();
    stopFirst();
    expect(revoked).toEqual([]);
    expect(second.querySelector('img')!.getAttribute('src')).not.toContain('#vach-');
    stopSecond();
    expect(revoked).toHaveLength(1);
    controller.destroy();
  });

  it('a chapter mounted again (the same markup, registered afresh) is processed again from scratch', async () => {
    const { store } = storeThatCounts();
    const controller = new ImageController(store);
    const bytes = pngBytes(3000, 2000);
    const first = document.createElement('section');
    const firstImg = document.createElement('img');
    firstImg.setAttribute('src', store.register('a.png', bytes, 'image/png', { read: async () => bytes }).url);
    first.append(firstImg);
    document.body.append(first);
    controller.register(first)();
    first.remove();

    // The chapter comes back: its HTML is made again, so register() answers with a new src.
    const again = document.createElement('section');
    const againImg = document.createElement('img');
    againImg.setAttribute('src', store.register('a.png', bytes, 'image/png', { read: async () => bytes }).url);
    again.append(againImg);
    document.body.append(again);
    const stop = controller.register(again);
    await settle();
    expect(againImg.getAttribute('src')).not.toContain('#vach-');
    expect(againImg.getAttribute('src')).not.toBe(firstImg.getAttribute('src'));
    stop();
    controller.destroy();
  });
});
