// Stands in for src/lib/fileBridge.ts in the PDF and ranged-EPUB measurements: "the native bridge" is HTTP range requests to the
// harness (which serves the generated files from disk), so a real 100 MB PDF can be opened without ever holding a copy of it in
// the page, the way the phone's bridge hands over one slice at a time. Every call is counted and can be given a fixed delay
// (window.__bridgeLatencyMs) to model the native round trip.
//
// content://x/<name> is fetched from /files/<name>.
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;
export const NATIVE_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_BOOK_BYTES = 150 * 1024 * 1024;

export class FileTooLargeError extends Error {}

interface BridgeStats {
  calls: number;
  bytes: number;
}
const stats: BridgeStats = ((window as unknown as { __bridge?: BridgeStats }).__bridge ??= { calls: 0, bytes: 0 });
const sizes = new Map<string, number>();

const pathOf = (uri: string) => `/files/${encodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1))}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function latency() {
  const ms = (window as unknown as { __bridgeLatencyMs?: number }).__bridgeLatencyMs ?? 0;
  if (ms > 0) await sleep(ms);
}

export async function getSize(uri: string): Promise<number> {
  const known = sizes.get(uri);
  if (known !== undefined) return known;
  await latency();
  const head = await fetch(pathOf(uri), { method: 'HEAD' });
  const size = Number(head.headers.get('content-length'));
  sizes.set(uri, size);
  return size;
}

export async function readRange(uri: string, offset: number, length: number): Promise<Uint8Array> {
  if (length <= 0) return new Uint8Array(0);
  await latency();
  const response = await fetch(pathOf(uri), { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
  const bytes = new Uint8Array(await response.arrayBuffer());
  stats.calls++;
  stats.bytes += bytes.length;
  return bytes;
}

export async function readAll(uri: string, options: { knownSize?: number } = {}): Promise<Uint8Array> {
  const size = options.knownSize ?? (await getSize(uri));
  const out = new Uint8Array(size);
  for (let at = 0; at < size; at += DEFAULT_CHUNK_BYTES) out.set(await readRange(uri, at, Math.min(DEFAULT_CHUNK_BYTES, size - at)), at);
  return out;
}

export async function createFileSource(uri: string) {
  const size = await getSize(uri);
  return {
    size,
    read: (begin: number, end: number) => readRange(uri, begin, Math.max(0, Math.min(end, size) - begin)),
  };
}

export type ReadOptions = { knownSize?: number; signal?: AbortSignal };
