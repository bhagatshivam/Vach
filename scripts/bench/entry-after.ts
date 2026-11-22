// Phase 1b behavior: open lazily (whole-file JSZip up to the threshold, ranged
// central-directory reads above it), then stream from the saved chapter.
import { restoreWindowStart } from '../../src/lib/chapterWindow';
import { openEpubFile } from '../../src/lib/epubFile';
import { MemoryProbe, loadFixture, makeBridge, now, parseArgs, report, round } from './harness';
import { openZip } from '../../src/lib/zipReader';
import { archiveFromJSZip, openEpub } from '../../src/lib/epub';
import type { EpubBook } from '../../src/lib/epub';

const args = parseArgs(process.argv.slice(2));
const file = loadFixture(args.fixture);
const { transport, stats } = makeBridge(file, args.latency);

const memory = new MemoryProbe();
await memory.start();

const t0 = now();
let book: EpubBook;
if (args.direct) {
  // Bypasses openEpubFile's 150 MiB sanity ceiling - only to show the ranged reader scales past it.
  const archive = await openZip({
    size: file.length,
    read: async (begin, end) => {
      const chunks: Uint8Array[] = [];
      for (let at = begin; at < end; at += 1048576) {
        const { base64 } = await transport.readChunk('bench://book', at, Math.min(1048576, end - at));
        chunks.push(new Uint8Array(Buffer.from(base64, 'base64')));
      }
      return chunks.length === 1 ? chunks[0] : new Uint8Array(Buffer.concat(chunks));
    },
  });
  book = await openEpub(archive, 'book.epub');
  void archiveFromJSZip; // (kept referenced so both adapters are in the bundle on every build)
} else {
  const wholeFileMaxBytes = args.path === 'whole' ? Number.MAX_SAFE_INTEGER : args.path === 'ranged' ? 0 : undefined;
  book = await openEpubFile('bench://book', 'book.epub', { transport, wholeFileMaxBytes });
}
const tOpen = now() - t0;

const start = args.index > 0 ? restoreWindowStart(args.index, book.chapterCount) : 0;
const generator = book.stream(start);
let tFirstChapter = NaN;
let tFirst4 = NaN;
let tTarget = NaN;
let tAll = NaN;
let chaptersParsed = 0;

for (;;) {
  const { value: event, done } = await generator.next();
  if (done) {
    tAll = now() - t0;
    break;
  }
  if (event.type !== 'chapter') continue;
  chaptersParsed++;
  memory.sample();
  const index = start + chaptersParsed - 1;
  if (chaptersParsed === 1) tFirstChapter = now() - t0;
  if (chaptersParsed === 4) {
    tFirst4 = now() - t0;
    if (args.until === 'first4') break;
  }
  if (index === args.index) {
    tTarget = now() - t0;
    if (args.until === 'target') break;
  }
}

const mem = await memory.finish();
report({
  flow: 'after',
  path: args.direct ? 'direct-ranged' : args.path,
  total: book.chapterCount,
  startIndex: start,
  chaptersParsed,
  openMs: round(tOpen),
  firstChapterMs: round(tFirstChapter),
  first4Ms: round(tFirst4),
  targetMs: round(tTarget),
  allMs: round(tAll),
  readCalls: stats.readCalls,
  bytesTransferredMiB: round(stats.bytesTransferred / 1048576),
  ...mem,
  keepAlive: book.chapterCount > 0,
});
