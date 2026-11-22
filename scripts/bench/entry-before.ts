// The behavior on main before Phase 1b: read the whole file (readAll), load it
// whole into JSZip, then stream chapters from chapter 0 - a saved position at
// chapter N could only be reached after chapters 0..N-1 were parsed.
import { readAll } from '../../src/lib/fileBridge';
import { streamEpub } from '../../src/lib/epub';
import { MemoryProbe, loadFixture, makeBridge, now, parseArgs, report, round } from './harness';

const args = parseArgs(process.argv.slice(2));
const file = loadFixture(args.fixture);
const { transport, stats } = makeBridge(file, args.latency);

const memory = new MemoryProbe();
await memory.start();

const t0 = now();
const bytes = await readAll('bench://book', { transport });
const tRead = now() - t0;

const generator = streamEpub(bytes, 'book.epub');
let tOpen = NaN;
let tFirstChapter = NaN;
let tFirst4 = NaN;
let tTarget = NaN;
let tAll = NaN;
let chapters = 0;
let total = 0;
let chaptersParsed = 0;

for (;;) {
  const { value: event, done } = await generator.next();
  if (done) {
    tAll = now() - t0;
    break;
  }
  if (event.type === 'total') {
    tOpen = now() - t0;
    total = event.count;
  } else if (event.type === 'chapter') {
    chapters++;
    chaptersParsed++;
    memory.sample();
    if (chapters === 1) tFirstChapter = now() - t0;
    if (chapters === 4) {
      tFirst4 = now() - t0;
      if (args.until === 'first4') break;
    }
    if (chapters === args.index + 1) {
      tTarget = now() - t0;
      if (args.until === 'target') break;
    }
  }
}

const mem = await memory.finish();
report({
  flow: 'before',
  total,
  chaptersParsed,
  readMs: round(tRead),
  openMs: round(tOpen),
  firstChapterMs: round(tFirstChapter),
  first4Ms: round(tFirst4),
  targetMs: round(tTarget),
  allMs: round(tAll),
  readCalls: stats.readCalls,
  bytesTransferredMiB: round(stats.bytesTransferred / 1048576),
  ...mem,
  keepAlive: bytes.length > 0 && generator !== null, // keep the book referenced until after the retained-memory reading
});
