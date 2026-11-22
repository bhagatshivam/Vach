// @vitest-environment node
import { deflateRawSync } from 'node:zlib';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  ZipFormatError,
  openZip,
  parseCentralDirectory,
  parseEndOfCentralDirectory,
  type ZipByteSource,
} from './zipReader';

// ---------------------------------------------------------------------------
// A minimal ZIP writer for fixtures JSZip can't (or shouldn't) produce:
// arbitrary method/flag values, raw name bytes, oversized local extra fields,
// data descriptors, ZIP64 markers, comments containing fake EOCD signatures.
// ---------------------------------------------------------------------------

interface FixtureEntry {
  name: string | Uint8Array;
  data: Uint8Array;
  method?: number; // 0 stored (default), 8 deflate; anything else is written as-is, data untouched
  flags?: number;
  localExtra?: number; // bytes of padding in the LOCAL header's extra field
  dataDescriptor?: boolean;
  zip64Sizes?: boolean; // write 0xFFFFFFFF sizes in the central directory
}

interface FixtureOptions {
  comment?: Uint8Array;
  zip64Locator?: boolean;
  eocdEntryCount?: number; // override the EOCD entry count
  trailingJunk?: Uint8Array;
}

function le16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function concat(parts: Array<Uint8Array | number[]>): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
const utf8 = (s: string) => new TextEncoder().encode(s);

function buildZip(entries: FixtureEntry[], options: FixtureOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = typeof entry.name === 'string' ? utf8(entry.name) : entry.name;
    const method = entry.method ?? 0;
    const stored = method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    let flags = entry.flags ?? 0;
    if (entry.dataDescriptor) flags |= 0x0008;
    const localExtra = new Uint8Array(entry.localExtra ?? 0);

    const localHeader = concat([
      le32(0x04034b50),
      le16(20),
      le16(flags),
      le16(method),
      le16(0),
      le16(0),
      le32(0), // crc (not checked)
      le32(entry.dataDescriptor ? 0 : stored.length),
      le32(entry.dataDescriptor ? 0 : entry.data.length),
      le16(nameBytes.length),
      le16(localExtra.length),
      nameBytes,
      localExtra,
    ]);
    const descriptor = entry.dataDescriptor
      ? concat([le32(0x08074b50), le32(0), le32(stored.length), le32(entry.data.length)])
      : new Uint8Array(0);
    parts.push(localHeader, stored, descriptor);

    central.push(
      concat([
        le32(0x02014b50),
        le16(20),
        le16(20),
        le16(flags),
        le16(method),
        le16(0),
        le16(0),
        le32(0),
        le32(entry.zip64Sizes ? 0xffffffff : stored.length),
        le32(entry.zip64Sizes ? 0xffffffff : entry.data.length),
        le16(nameBytes.length),
        le16(0),
        le16(0),
        le16(0),
        le16(0),
        le32(0),
        le32(offset),
        nameBytes,
      ]),
    );
    offset += localHeader.length + stored.length + descriptor.length;
  }

  const cd = concat(central);
  const comment = options.comment ?? new Uint8Array(0);
  const locator = options.zip64Locator ? concat([le32(0x07064b50), le32(0), new Uint8Array(8), le32(1)]) : new Uint8Array(0); // locator is 20 bytes, as in the spec
  const eocd = concat([
    le32(0x06054b50),
    le16(0),
    le16(0),
    le16(options.eocdEntryCount ?? entries.length),
    le16(options.eocdEntryCount ?? entries.length),
    le32(cd.length),
    le32(offset),
    le16(comment.length),
    comment,
  ]);
  return concat([...parts, cd, locator, eocd, options.trailingJunk ?? new Uint8Array(0)]);
}

function memorySource(bytes: Uint8Array): ZipByteSource & { reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  return {
    size: bytes.length,
    reads,
    read: async (begin, end) => {
      reads.push([begin, end]);
      return bytes.slice(begin, end);
    },
  };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const CAP = 10 * 1024 * 1024;

describe('openZip - entries', () => {
  it('reads stored and deflated entries', async () => {
    const zip = buildZip([
      { name: 'a.txt', data: utf8('stored entry'), method: 0 },
      { name: 'b.txt', data: utf8('deflated entry '.repeat(50)), method: 8 },
    ]);
    const archive = await openZip(memorySource(zip));
    expect(text(await archive.read('a.txt', CAP))).toBe('stored entry');
    expect(text(await archive.read('b.txt', CAP))).toBe('deflated entry '.repeat(50));
  });

  it('indexes entries with their sizes and method, and has() is exact and case-sensitive', async () => {
    const zip = buildZip([{ name: 'OEBPS/ch1.xhtml', data: utf8('<p>x</p>'), method: 8 }]);
    const archive = await openZip(memorySource(zip));
    const entry = archive.entries.get('OEBPS/ch1.xhtml')!;
    expect(entry.method).toBe(8);
    expect(entry.uncompressedSize).toBe(8);
    expect(archive.has('OEBPS/ch1.xhtml')).toBe(true);
    expect(archive.has('oebps/ch1.xhtml')).toBe(false);
    expect(archive.has('OEBPS/missing.xhtml')).toBe(false);
  });

  it('skips directory entries', async () => {
    const zip = buildZip([
      { name: 'OEBPS/', data: new Uint8Array(0) },
      { name: 'OEBPS/a.txt', data: utf8('a') },
    ]);
    const archive = await openZip(memorySource(zip));
    expect(archive.has('OEBPS/')).toBe(false);
    expect(archive.has('OEBPS/a.txt')).toBe(true);
  });

  it('reads an empty entry (stored and deflate)', async () => {
    const zip = buildZip([
      { name: 'empty-stored', data: new Uint8Array(0), method: 0 },
      { name: 'empty-deflate', data: new Uint8Array(0), method: 8 },
    ]);
    const archive = await openZip(memorySource(zip));
    expect(await archive.read('empty-stored', CAP)).toHaveLength(0);
    expect(await archive.read('empty-deflate', CAP)).toHaveLength(0);
  });

  it('works on an archive with no entries', async () => {
    const archive = await openZip(memorySource(buildZip([])));
    expect(archive.entries.size).toBe(0);
    expect(archive.has('anything')).toBe(false);
  });

  it('rejects reading a missing entry', async () => {
    const archive = await openZip(memorySource(buildZip([{ name: 'a', data: utf8('a') }])));
    await expect(archive.read('nope', CAP)).rejects.toThrow(/not found/);
  });

  it('agrees with JSZip on archives JSZip wrote (deflate + store, folders, streamed descriptors)', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('OEBPS/text/ch1.xhtml', '<p>chapter one</p>'.repeat(200), { compression: 'DEFLATE' });
    zip.file('OEBPS/img/cover.bin', new Uint8Array(5000).map((_, i) => (i * 7) & 0xff), { compression: 'DEFLATE' });
    zip.folder('OEBPS/empty-dir');
    for (const streamFiles of [false, true]) {
      const bytes = await zip.generateAsync({ type: 'uint8array', streamFiles });
      const archive = await openZip(memorySource(bytes));
      expect(text(await archive.read('mimetype', CAP))).toBe('application/epub+zip');
      expect(text(await archive.read('OEBPS/text/ch1.xhtml', CAP))).toBe('<p>chapter one</p>'.repeat(200));
      expect(Array.from(await archive.read('OEBPS/img/cover.bin', CAP))).toEqual(Array.from(new Uint8Array(5000).map((_, i) => (i * 7) & 0xff)));
    }
  });
});

describe('openZip - names', () => {
  it('decodes UTF-8 names when the UTF-8 flag is set', async () => {
    const name = 'OEBPS/अध्याय-१.xhtml';
    const zip = buildZip([{ name, data: utf8('नमस्ते'), flags: 0x0800, method: 8 }]);
    const archive = await openZip(memorySource(zip));
    expect(archive.has(name)).toBe(true);
    expect(text(await archive.read(name, CAP))).toBe('नमस्ते');
  });

  it('decodes JSZip-written non-ASCII names (it sets the flag itself)', async () => {
    const zip = new JSZip();
    zip.file('OEBPS/Café ☕ 章.xhtml', 'x');
    const archive = await openZip(memorySource(await zip.generateAsync({ type: 'uint8array' })));
    expect(archive.has('OEBPS/Café ☕ 章.xhtml')).toBe(true);
  });

  it('treats valid UTF-8 names without the flag as UTF-8 (EPUB tools often omit it)', async () => {
    const name = 'OEBPS/résumé.xhtml';
    const archive = await openZip(memorySource(buildZip([{ name, data: utf8('x'), flags: 0 }])));
    expect(archive.has(name)).toBe(true);
  });

  it('keeps an entry with an invalid-UTF-8, unflagged name addressable (one char per byte)', async () => {
    const raw = new Uint8Array([0x66, 0xe9, 0x2e, 0x74]); // "fé.t" in latin1, invalid as UTF-8
    const archive = await openZip(memorySource(buildZip([{ name: raw, data: utf8('x') }])));
    expect(archive.has('fé.t')).toBe(true);
  });
});

describe('openZip - archive comment and trailing bytes', () => {
  it('finds the EOCD when the archive has a comment', async () => {
    const zip = buildZip([{ name: 'a', data: utf8('a') }], { comment: utf8('created by a very chatty tool') });
    const archive = await openZip(memorySource(zip));
    expect(text(await archive.read('a', CAP))).toBe('a');
  });

  it('is not fooled by an EOCD signature inside the comment', async () => {
    const fake = concat([le32(0x06054b50), new Uint8Array(18)]); // looks like an EOCD with comment length 0
    const zip = buildZip([{ name: 'a', data: utf8('a') }], { comment: concat([utf8('x'), fake, utf8('y')]) });
    const archive = await openZip(memorySource(zip));
    expect(text(await archive.read('a', CAP))).toBe('a');
  });

  it('handles the maximum-size (65,535 byte) comment', async () => {
    const zip = buildZip([{ name: 'a', data: utf8('a') }], { comment: new Uint8Array(65535).fill(0x41) });
    const archive = await openZip(memorySource(zip));
    expect(archive.has('a')).toBe(true);
  });

  it('tolerates junk after the end of the archive', async () => {
    const zip = buildZip([{ name: 'a', data: utf8('a') }], { trailingJunk: new Uint8Array(40).fill(0) });
    const archive = await openZip(memorySource(zip));
    expect(text(await archive.read('a', CAP))).toBe('a');
  });
});

describe('openZip - data descriptors and local headers', () => {
  it('reads entries written with a data descriptor (sizes zero in the local header)', async () => {
    const zip = buildZip([
      { name: 'a', data: utf8('descriptor stored'), method: 0, dataDescriptor: true },
      { name: 'b', data: utf8('descriptor deflated '.repeat(20)), method: 8, dataDescriptor: true },
    ]);
    const archive = await openZip(memorySource(zip));
    expect(text(await archive.read('a', CAP))).toBe('descriptor stored');
    expect(text(await archive.read('b', CAP))).toBe('descriptor deflated '.repeat(20));
  });

  it('finds the data when the local extra field is much larger than the central one', async () => {
    const zip = buildZip([
      { name: 'first', data: utf8('first'), localExtra: 3000 },
      { name: 'second', data: utf8('second '.repeat(100)), method: 8, localExtra: 700 },
    ]);
    const archive = await openZip(memorySource(zip));
    expect(text(await archive.read('first', CAP))).toBe('first');
    expect(text(await archive.read('second', CAP))).toBe('second '.repeat(100));
  });
});

describe('openZip - unsupported and size-capped entries', () => {
  it('throws a clear error for an unsupported compression method, only when that entry is read', async () => {
    const zip = buildZip([
      { name: 'ok.txt', data: utf8('fine') },
      { name: 'shrunk.txt', data: utf8('whatever'), method: 1 },
    ]);
    const archive = await openZip(memorySource(zip));
    expect(text(await archive.read('ok.txt', CAP))).toBe('fine');
    await expect(archive.read('shrunk.txt', CAP)).rejects.toThrow(
      'Unsupported ZIP compression method 1 for "shrunk.txt" (only stored and deflate are supported)',
    );
  });

  it('throws a clear error for an encrypted entry', async () => {
    const zip = buildZip([{ name: 'secret.txt', data: utf8('x'), flags: 0x0001 }]);
    const archive = await openZip(memorySource(zip));
    await expect(archive.read('secret.txt', CAP)).rejects.toThrow(/encrypted/);
  });

  it('enforces the cap on real decompressed output, not on the declared size (zip bomb)', async () => {
    const bomb = new Uint8Array(2 * 1024 * 1024); // 2 MiB of zeros deflates to ~2 KB
    const zip = buildZip([{ name: 'bomb', data: bomb, method: 8 }]);
    const archive = await openZip(memorySource(zip));
    expect(archive.entries.get('bomb')!.compressedSize).toBeLessThan(10_000);
    await expect(archive.read('bomb', 1024 * 1024)).rejects.toThrow('Entry "bomb" exceeds the 1048576-byte decompressed-size cap');
    expect((await archive.read('bomb', 4 * 1024 * 1024)).length).toBe(bomb.length);
  });

  it('enforces the cap on a stored entry', async () => {
    const zip = buildZip([{ name: 'big', data: new Uint8Array(5000), method: 0 }]);
    const archive = await openZip(memorySource(zip));
    await expect(archive.read('big', 4999)).rejects.toThrow(/exceeds the 4999-byte/);
    expect((await archive.read('big', 5000)).length).toBe(5000);
  });

  it('a deflate stream that is garbage fails with a clear "corrupt" error', async () => {
    const zip = buildZip([{ name: 'bad', data: utf8('hello world hello world'), method: 8 }]);
    // Overwrite the deflate payload (after the 30+3 byte local header) with 0xFF bytes.
    const dataStart = 30 + 3;
    zip.fill(0xff, dataStart, dataStart + 8);
    const archive = await openZip(memorySource(zip));
    await expect(archive.read('bad', CAP)).rejects.toThrow(/looks corrupt: "bad" could not be decompressed/);
  });
});

describe('openZip - not a zip / corrupt / unsupported archives', () => {
  it.each([
    ['an empty file', new Uint8Array(0)],
    ['fewer bytes than an EOCD record', new Uint8Array(10)],
    ['plain text', utf8('This is definitely not a zip file, it is just some text. '.repeat(10))],
    ['zeros', new Uint8Array(5000)],
  ])('rejects %s with a clear error', async (_label, bytes) => {
    const error = await openZip(memorySource(bytes)).catch((e) => e);
    expect(error).toBeInstanceOf(ZipFormatError);
    expect(error.message).toMatch(/Not a valid ZIP archive/);
  });

  it('rejects an archive cut off before its end (the EOCD is gone)', async () => {
    const zip = buildZip([{ name: 'a', data: utf8('a'.repeat(500)), method: 8 }, { name: 'b', data: utf8('b') }]);
    for (const keep of [zip.length - 1, zip.length - 22, Math.floor(zip.length / 2), 40]) {
      await expect(openZip(memorySource(zip.slice(0, keep)))).rejects.toBeInstanceOf(ZipFormatError);
    }
  });

  it('rejects a damaged central directory signature', async () => {
    const zip = buildZip([{ name: 'a', data: utf8('a') }]);
    const cdOffset = zip.length - 22 - (46 + 1);
    zip[cdOffset] = 0x00;
    await expect(openZip(memorySource(zip))).rejects.toThrow(/file index is damaged/);
  });

  it('rejects a central directory that points outside the file', async () => {
    const zip = buildZip([{ name: 'a', data: utf8('a') }]);
    const eocd = zip.length - 22;
    zip.set(le32(zip.length + 1000), eocd + 16); // cd offset beyond the end
    await expect(openZip(memorySource(zip))).rejects.toThrow(/points outside the file/);
  });

  it('rejects an entry count larger than the directory actually holds', async () => {
    const zip = buildZip([{ name: 'a', data: utf8('a') }], { eocdEntryCount: 5 });
    await expect(openZip(memorySource(zip))).rejects.toBeInstanceOf(ZipFormatError);
  });

  it('rejects an entry whose local header offset is wrong, when that entry is read', async () => {
    const zip = buildZip([{ name: 'a', data: utf8('a') }, { name: 'b', data: utf8('b') }]);
    const archive = await openZip(memorySource(zip));
    // 'b' is fine; corrupt 'a''s local header signature after opening.
    zip[0] = 0x00;
    await expect(archive.read('a', CAP)).rejects.toThrow(/damaged file header/);
    expect(text(await archive.read('b', CAP))).toBe('b');
  });

  it('rejects an entry whose data runs past the end of the file', async () => {
    const zip = buildZip([{ name: 'a', data: utf8('a') }]);
    const cd = zip.length - 22 - 47;
    zip.set(le32(999_999), cd + 20); // compressed size far past the file
    const archive = await openZip(memorySource(zip));
    await expect(archive.read('a', 10_000_000)).rejects.toThrow(/cut short/);
  });

  it('fails clearly on ZIP64: locator, placeholder entry count, and placeholder sizes', async () => {
    const withLocator = buildZip([{ name: 'a', data: utf8('a') }], { zip64Locator: true });
    await expect(openZip(memorySource(withLocator))).rejects.toThrow(/ZIP64/);

    const placeholderCount = buildZip([{ name: 'a', data: utf8('a') }], { eocdEntryCount: 0xffff });
    await expect(openZip(memorySource(placeholderCount))).rejects.toThrow(/ZIP64/);

    const placeholderSizes = buildZip([{ name: 'a', data: utf8('a'), zip64Sizes: true }]);
    await expect(openZip(memorySource(placeholderSizes))).rejects.toThrow(/ZIP64/);
  });

  it('rejects multi-part archives', async () => {
    const zip = buildZip([{ name: 'a', data: utf8('a') }]);
    zip.set(le16(1), zip.length - 22 + 4); // disk number 1
    await expect(openZip(memorySource(zip))).rejects.toThrow(/Multi-part/);
  });
});

describe('record parsers', () => {
  it('parseEndOfCentralDirectory reports counts, sizes and offsets', () => {
    const zip = buildZip([{ name: 'a', data: utf8('hello') }, { name: 'b', data: utf8('world') }]);
    const eocd = parseEndOfCentralDirectory(zip);
    expect(eocd.entryCount).toBe(2);
    expect(eocd.centralDirectorySize).toBe(2 * 47);
    expect(eocd.position).toBe(zip.length - 22);
    expect(eocd.centralDirectoryOffset + eocd.centralDirectorySize).toBe(eocd.position);
  });

  it('parseCentralDirectory rejects a record cut short by its own name length', () => {
    const zip = buildZip([{ name: 'a-long-name.txt', data: utf8('x') }]);
    const eocd = parseEndOfCentralDirectory(zip);
    const cd = zip.slice(eocd.centralDirectoryOffset, eocd.centralDirectoryOffset + 50); // cut inside the name
    expect(() => parseCentralDirectory(cd, 1)).toThrow(/cut short/);
  });
});

describe('openZip - what it reads', () => {
  function bigArchive(entryCount: number, entrySize: number): Uint8Array {
    const entries: FixtureEntry[] = [];
    for (let i = 0; i < entryCount; i++) {
      entries.push({ name: `ch${i}.xhtml`, data: new Uint8Array(entrySize).fill(65 + (i % 26)), method: 8 });
    }
    return buildZip(entries);
  }

  it('opening reads only the tail and the central directory, never entry data', async () => {
    const zip = buildZip([{ name: 'big', data: new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 2654435761) >>> 24) }]);
    const source = memorySource(zip);
    await openZip(source);
    const bytesRead = source.reads.reduce((n, [b, e]) => n + (e - b), 0);
    expect(bytesRead).toBeLessThanOrEqual(22 + 20 + 65535);
    expect(source.reads.every(([b]) => b >= zip.length - (22 + 20 + 65535))).toBe(true);
  });

  it('reuses the tail read for a small central directory (one read in total to open)', async () => {
    const source = memorySource(buildZip([{ name: 'a', data: utf8('a') }]));
    await openZip(source);
    expect(source.reads).toHaveLength(1);
  });

  it('reads a central directory larger than the tail with one extra read', async () => {
    // ~3,000 entries with long names: the directory is well over 64 KiB.
    const entries: FixtureEntry[] = [];
    for (let i = 0; i < 3000; i++) entries.push({ name: `OEBPS/Text/chapter-with-a-fairly-long-name-${i}.xhtml`, data: utf8(`c${i}`) });
    const zip = buildZip(entries);
    const source = memorySource(zip);
    const archive = await openZip(source);
    expect(archive.entries.size).toBe(3000);
    expect(source.reads).toHaveLength(2);
    expect(text(await archive.read('OEBPS/Text/chapter-with-a-fairly-long-name-2999.xhtml', CAP))).toBe('c2999');
  });

  it('serves neighbouring small entries from one cached block instead of one read each', async () => {
    const zip = bigArchive(100, 2000);
    const source = memorySource(zip);
    const archive = await openZip(source, { blockBytes: 64 * 1024 });
    const opened = source.reads.length;
    for (let i = 0; i < 100; i++) {
      expect((await archive.read(`ch${i}.xhtml`, CAP))[0]).toBe(65 + (i % 26));
    }
    const entryReads = source.reads.length - opened;
    // 100 entries of ~a few dozen compressed bytes sit inside the first block(s).
    expect(entryReads).toBeLessThanOrEqual(3);
  });

  it('reads an entry larger than a cache block directly, without caching it', async () => {
    const big = new Uint8Array(200 * 1024).map((_, i) => (i * 2654435761) >>> 24); // incompressible
    const zip = buildZip([{ name: 'img', data: big }, { name: 'after', data: utf8('after') }]);
    const source = memorySource(zip);
    const archive = await openZip(source, { blockBytes: 64 * 1024 });
    const opened = source.reads.length;
    expect(Array.from(await archive.read('img', CAP))).toEqual(Array.from(big));
    // One read for the body (header + slack + data in one request), nothing block-sized.
    expect(source.reads.length - opened).toBe(1);
    expect(text(await archive.read('after', CAP))).toBe('after');
  });

  it('an entry that straddles two cache blocks is assembled correctly', async () => {
    const parts: FixtureEntry[] = [
      { name: 'pad', data: new Uint8Array(1000).map((_, i) => (i * 2654435761) >>> 24) },
      { name: 'straddle', data: new Uint8Array(900).map((_, i) => (i * 40503) >>> 8) },
    ];
    const zip = buildZip(parts);
    // Block size 1,100 puts the boundary inside 'straddle' (header + 1000 pad + ...).
    const archive = await openZip(memorySource(zip), { blockBytes: 1100 });
    expect(Array.from(await archive.read('straddle', CAP))).toEqual(Array.from(parts[1].data));
  });

  it('every read stays inside the file', async () => {
    const zip = bigArchive(50, 5000);
    const source = memorySource(zip);
    const archive = await openZip(source, { blockBytes: 4096 });
    for (let i = 0; i < 50; i++) await archive.read(`ch${i}.xhtml`, CAP);
    for (const [b, e] of source.reads) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(zip.length);
      expect(e).toBeGreaterThan(b);
    }
  });
});
