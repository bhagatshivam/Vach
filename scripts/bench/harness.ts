// Shared by the benchmark entries: a fake file bridge with configurable
// per-call latency, memory probes (Linux /proc), and result reporting.
import { readFileSync, writeFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import type { ChunkTransport } from '../../src/lib/fileBridge';

export const MIB = 1024 * 1024;

export interface Args {
  fixture: string;
  latency: number;
  index: number;
  until: 'target' | 'first4' | 'all';
  path: 'auto' | 'whole' | 'ranged';
  direct: boolean;
}

export function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
  };
  return {
    fixture: get('fixture', ''),
    latency: Number(get('latency', '3')),
    index: Number(get('index', '0')),
    until: (['all', 'first4'].includes(get('until', 'target')) ? get('until', 'target') : 'target') as Args['until'],
    path: get('path', 'auto') as Args['path'],
    direct: argv.includes('--direct'),
  };
}

export const now = (): number => performance.now();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface BridgeStats {
  readCalls: number;
  sizeCalls: number;
  bytesTransferred: number;
}

/** An in-memory "file" behind the same two calls the native plugin offers, each costing `latencyMs`. */
export function makeBridge(file: Buffer, latencyMs: number): { transport: ChunkTransport; stats: BridgeStats } {
  const stats: BridgeStats = { readCalls: 0, sizeCalls: 0, bytesTransferred: 0 };
  const transport: ChunkTransport = {
    async getSize() {
      stats.sizeCalls++;
      if (latencyMs > 0) await sleep(latencyMs);
      return file.length;
    },
    async readChunk(_uri, offset, length) {
      stats.readCalls++;
      if (latencyMs > 0) await sleep(latencyMs);
      const slice = file.subarray(Math.min(offset, file.length), Math.min(offset + length, file.length));
      stats.bytesTransferred += slice.length;
      return { base64: slice.toString('base64'), length: slice.length };
    },
  };
  return { transport, stats };
}

export const loadFixture = (path: string): Buffer => readFileSync(path);

// ---------------------------------------------------------------------------
// Memory (Linux). VmHWM is the kernel's own peak-RSS counter, so it catches
// spikes a timer would miss; /proc/self/clear_refs "5" resets it.
// ---------------------------------------------------------------------------

function procStatusMiB(field: string): number {
  const text = readFileSync('/proc/self/status', 'utf8');
  const match = new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(text);
  return match ? Number(match[1]) / 1024 : NaN;
}

export const rssMiB = (): number => procStatusMiB('VmRSS');
export const peakRssMiB = (): number => procStatusMiB('VmHWM');
export const resetPeakRss = (): void => writeFileSync('/proc/self/clear_refs', '5');

const gc = (): void => (globalThis as unknown as { gc?: () => void }).gc?.();

/** Full GC, twice with a tick between, so freed buffers are really returned. */
export async function settle(): Promise<void> {
  gc();
  await sleep(20);
  gc();
}

export const heapUsedMiB = (): number => getHeapStatistics().used_heap_size / MIB;
export const externalMiB = (): number => process.memoryUsage().arrayBuffers / MIB;

export class MemoryProbe {
  baseRss = 0;
  baseHeap = 0;
  baseExternal = 0;
  maxHeap = 0;
  maxExternal = 0;

  async start(): Promise<void> {
    await settle();
    this.baseRss = rssMiB();
    this.baseHeap = heapUsedMiB();
    this.baseExternal = externalMiB();
    this.maxHeap = this.baseHeap;
    this.maxExternal = this.baseExternal;
    resetPeakRss();
  }

  /** Cheap enough to call per chapter / per bridge call. */
  sample(): void {
    this.maxHeap = Math.max(this.maxHeap, heapUsedMiB());
    this.maxExternal = Math.max(this.maxExternal, externalMiB());
  }

  async finish(): Promise<Record<string, number>> {
    this.sample();
    const peakRss = peakRssMiB();
    await settle();
    return {
      peakRssDeltaMiB: round(peakRss - this.baseRss),
      sampledPeakHeapDeltaMiB: round(this.maxHeap - this.baseHeap),
      sampledPeakBuffersDeltaMiB: round(this.maxExternal - this.baseExternal),
      retainedHeapDeltaMiB: round(heapUsedMiB() - this.baseHeap),
      retainedBuffersDeltaMiB: round(externalMiB() - this.baseExternal),
    };
  }
}

export const round = (n: number, digits = 1): number => Math.round(n * 10 ** digits) / 10 ** digits;

export function report(result: Record<string, unknown>): void {
  console.log(`RESULT ${JSON.stringify(result)}`);
}
