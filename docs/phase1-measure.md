# Phase 1a: what a long book costs the page (measured), and bounded chapter mounting

Why this exists: PR #12 found that Chromium stops painting past about 2^23 px (8,388,608 CSS px) of scroll offset. The DOM and the
geometry still say the text is there, but the screen is blank, and it stays blank while scrolling nearby. PR #12 only patched jumps
from the Contents drawer. Before Phase 1a the reader mounted **every chapter after the reader's position** and never unmounted
anything, so a long book was one very tall page and a hard fling down it could still end in the blank.

## How it was measured

`scripts/verify/mount-measure-chromium.mjs`: headless Chromium, 360x800 at DPR 2.75, touch, **CPU throttled 4x**, the REAL
`ReaderScreen`, CSS, sanitizer, table and image controllers, Contents drawer and `PdfPageLoader`, with the file bridge faked (the same
stubs as the other `scripts/verify` checks). Books are synthetic and deterministic (`scripts/verify/syntheticBooks.mjs`,
`scripts/bench/gen-docx-bench.mjs`, `scripts/verify/pdfSyntheticStub.ts`). Per book it records:

- **chapters mounted / DOM nodes / page height** after the book has settled (`document.documentElement.scrollHeight`)
- **JS heap** (`Runtime.getHeapUsage` after a forced GC), after opening
- **time to first text**: from asking to open the book until a chapter with text is in the page and revealed
- **fling frame gaps**: ten flings of 30,000 px at 300 px per frame (about twice what a hard swipe reaches), starting at ten places through the book (found through the Contents drawer when the book has one); the longest and the median-of-95th-percentile `requestAnimationFrame` gap, and how many gaps were over 50 ms
- **painted-pixel checks** (a screenshot, counting pixels that differ from the page colour) at the start and end of each fling and every 150,000 px of a **continuous top-to-bottom traverse** at 2,000 px per frame. A screen with no ink is blank.

This is desktop Chromium, not a phone: compare the two columns with each other, not with a phone. Run it with
`node scripts/verify/mount-measure-chromium.mjs --label before --out before.json` (and `--table before.json after.json`).

## Baseline (origin/main at 6cf0680, before any change)

| Book | chapters mounted | DOM nodes | page height | JS heap | first text | fling max gap / median p95 / gaps over 50 ms | blank screens in the flings | continuous traverse |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| EPUB, 150 long chapters (the 10.5M px book from PR #12) | 150 | 2,565 | **10.74M px** | 4.0 MB | 388 ms | 550 ms / 17 ms / 21 | 0/20 | 10.74M px, **17 of 72 screens blank, the first at y = 8,400,080** |
| EPUB, 365 ordinary chapters (Les Miserables-sized) | 365 | 4,757 | 1.68M px | 4.3 MB | 301 ms | 17 ms / 17 ms / 0 | 0/20 | 1.68M px, 0/12 blank |
| DOCX, 100,000 words | 38 | 1,989 | 0.45M px | 5.1 MB | 849 ms | 17 ms / 17 ms / 0 | 0/20 | 0.45M px, 0/3 blank |
| PDF, 3,000 dense text pages | 3,000 | 18,014 | 5.93M px | 9.2 MB | 231 ms | 117 ms / 17 ms / 6 | 0/20 | 5.93M px, 0/40 blank |
| PDF, 20,000 scanned pages (measured while the text pass was still streaming: 16,475 of 20,000 pages in) | 16,475 of 20,000 | 49,440 | 7.31M px at that moment, **8.87M px** once all pages are in | 18.6 MB | 470 ms | 767 ms / 467 ms / 980 | 0/20 | 3.6M px in 12 minutes, 0/24 blank (it never got as far as 8.4M px) |

What the baseline says:

1. **The bug is real and sits exactly where PR #12 said.** In the continuous traverse of the 10.74M px book, every screen is painted up to
   y = 8,388,608 + a few thousand px, and **17 of the 72 screens after that are blank** - the first at y = 8,400,080. The flings that start
   from a Contents jump were all fine (0/20 blank) because a far jump reopens the window at the chapter, a short page; it is the
   *scrolling* that reaches the blank.
2. **Only the 10.7M px book is over the limit.** An ordinary long novel is 1.7M px and a 100,000-word Word document 0.45M px at this
   width and font size. (A real Les Miserables was 3-5M px at default settings in earlier measurements; big text or a narrow
   column makes any book taller. The limit depends on the font size and width, not on the book alone.)
3. **A PDF has the same problem at scale.** Every page is streamed and mounted from page 1. 3,000 dense text pages are already 5.93M px;
   the 8.39M px limit is reached at about **4,250 dense text pages** (about 1,980 px per page) or about **18,900 scanned pages** (about 444 px
   per page). A 20,000-page scanned PDF reached 8.87M px. See "PDF" below.
4. **Cost of mounting everything**: the fling jank on the 10.7M px book (max gap 550 ms, 21 gaps over 50 ms) and on the 20,000-page PDF
   (median p95 467 ms) is the cost of one huge layout plus a background text pass that keeps appending to it. DOM node counts are small for
   the EPUB (it is a few long paragraphs per chapter) and large for PDFs (18k and 49k nodes).

## Where the real code differs from the design in the brief

Read before building (these decided the shape of the change):

- **Nothing was ever unmounted.** `ReaderScreen` streamed the book from the saved chapter to the end (`opened.stream(startIndex)`) and
  appended every chapter to `book.chaptersHtml`; only *prepending* earlier chapters was windowed. So "unmount ahead and behind" is new
  behaviour, not a tweak.
- **`ImageStore` had no per-chapter release.** Every blob: URL ever made stayed alive until the book closed (`revokeAll`), and the EPUB
  and Word openers kept their own positive image caches that would have gone stale. Both are new here (`ImageStore.hold`, `known`).
- **The table engine already cleaned up per chapter** (`TableAdaptController.register` returns a stop function that drops the section's
  state); it just was never called for a chapter that left the page, because none did.
- **Nothing read the document scroll height as progress.** Reading progress, the Contents drawer's position and the size-weighted bar all
  already came from the chapter index measured from the DOM anchor plus `chapterWeights`/`totalChapters` (`measureAnchor`). So there was
  nothing to "fix"; Phase 1a adds tests that pin it (progress stays right when the window starts deep in the book).
- **A far Contents jump reopened the book** (PR #12): the whole `load` effect runs again at the target. With a bounded window that is now the
  path for every jump outside the window, not only for the last chapters. It still works through the same code; reopening in place
  (without reopening the file) would be a later improvement.
- **PDF.** The text pass is a stream from page 1 and `PdfPageLoader` assumes pages only ever get appended. A PDF cannot be windowed
  without either lazy page text (Phase 1b, which this task says not to start) or a different mount-only window over all the streamed
  pages. See "PDF" below.

## PDF: the same problem, at a larger scale

A PDF streams every page from page 1 and keeps all of them mounted, so the page is as tall as the whole book. Measured on unmodified main
(`--only pdf-4500`): **4,500 dense text pages are 8.89M px tall, and 5 of the 60 screens of a continuous traverse are blank, the first at
y = 8,400,000** - the same 2^23 cliff as the EPUB. In page counts, from the heights above: about 4,250 dense text pages, or about 18,900
scanned pages (a 20,000-page scanned PDF is 8.87M px). A typical PDF of a few hundred pages is nowhere near it.

## After Phase 1a: a bounded window of chapters

Same harness, same books, same machine settings (`node scripts/verify/mount-measure-chromium.mjs --label after`; the baseline above
was taken on unmodified main in a separate worktree). First-text times differ by up to ~100 ms between two runs of the very same code
(the PDF rows are code that did not change), so only larger differences than that mean anything.

| | before | after |
| --- | ---: | ---: |
| **EPUB, 150 long chapters (the 10.5M px book)** | | |
| chapters mounted / DOM nodes | 150 / 2,565 | 1 / 33 |
| page height | 10.74M px | 0.07M px (never above 0.14M px while reading it end to end) |
| JS heap after open / after reading it through | 4.0 / 4.8 MB | 3.5 / 4.7 MB |
| time to first text | 388 ms | 315 ms |
| fling frame gaps: max / over 50 ms | 550 ms / 21 | 17 ms / 0 |
| continuous top-to-bottom traverse, painted pixels | **17 of 72 screens blank**, from y = 8,400,080 | **0 of 72 blank** |
| **EPUB, 365 ordinary chapters (Les Miserables-sized)** | | |
| chapters mounted / DOM nodes | 365 / 4,757 | 3 / 49 |
| page height | 1.68M px | 0.01M px |
| JS heap after open | 4.3 MB | 3.6 MB |
| time to first text | 301 ms | 282 ms |
| fling frame gaps: max / over 50 ms | 17 ms / 0 | 17 ms / 0 |
| **DOCX, 100,000 words** | | |
| chapters mounted / DOM nodes | 38 / 1,989 | 1 / 48 |
| page height | 0.45M px | 0.01M px |
| time to first text | 849 ms | 872 ms (the conversion dominates, not mounting) |
| fling frame gaps: max / over 50 ms | 17 ms / 0 | 33 ms / 0 |
| **EPUB, 120 chapters each with its own big picture and 40 with a table, read slowly** | | |
| chapters mounted / DOM nodes / `<img>` mounted at the end | 120 / 2,615 / 120 | 4 / 128 / 6 |
| blob: URLs alive: most while reading / at the end | **121 / 121** | **16 / 7** |
| **PDF, 3,000 and 4,500 dense text pages** (not changed) | same as before | same as before: 5.93M and 8.89M px; the 4,500-page one is still blank from y = 8,400,000 |

Also measured, not in the table: while it was being read through, the 10.7M px book never mounted more than 2 chapters or 143,465 px of
page (the cap is 1,500,000 px) and no fling frame found the page out of chapters (0 stalled frames at 800 px per frame, six times what a
hard swipe reaches); an ordinary book flung at 2,000 px per frame (15 times a hard swipe) ran out of mounted chapters on 4 frames.

### The window policy, and why

`src/lib/mountWindow.ts` (pure, tested). It is given where each mounted chapter measures on screen right now and says what to load and
what to unmount:

- **Load** the next (previous) chapter while fewer than **5 screens** of mounted content remain below (above) the screen.
- **Unmount** a chapter from the far end of the window (ahead or behind) only if at least **12 screens** of mounted content would still
  remain beyond the screen without it. The chapter on screen, and every chapter between it and the reader, is never dropped.
- A hard ceiling of **1,500,000 px** of mounted page (the "target ~1.5M" and well under `MAX_DIRECT_JUMP_OFFSET_PX`, 2,000,000): if what is left is still taller, the chapter farthest from the screen goes, whichever end it is at.
- **Why it is in screens of measured text and not in chapters**: a chapter is 300 px or 70,000 px, so "active plus or minus N" is
  wrong for one or the other. The same rule gives 1 chapter for the 10.7M px book (each chapter is 70,000 px) and 3 to 12 for a book of short
  chapters; either way the page is about 5 to 17 screens of text, a few tens of thousands of px.
- **Why 5 and 12**: 5 screens (4,000 px on a phone) is about half a second of a hard fling (8,000 px/s), enough for one chapter to be read, sanitized
  and mounted before the reader gets there (it passed with 0 stalls at six times that speed here, and a phone is slower than this
  machine, which is the reason it is not 2). 12 screens before dropping means a chapter that was just loaded is not dropped again when the
  reader turns round, and the gap between 5 and 12 is the hysteresis that stops a chapter being loaded and dropped on alternate frames at a
  boundary (a unit test sweeps a boundary back and forth and sees no churn).
- **No placeholder spacers.** The page is exactly as tall as the mounted chapters. Anything standing in for an unmounted chapter would be height, and height is
  the problem.
- **Compensation**: removing chapters above the reader, or adding them, shifts the text by their height; the reader measures the chapter at the top of the
  screen before the change and scrolls by however far it moved after it, in the same commit (a layout effect, before paint). Measured on the element, so
  it is also right when the browser's scroll anchoring has already corrected. Checked in Chromium on 220 mount changes in slow drags and 343 in real compositor flings
  at 8,000 px/s: the text on screen never moved by more than a pixel.
- **Left alone** while a picture or an Expand Grid is open (the viewer holds what it shows, and nothing is mounted or unmounted underneath it) and while a
  font/theme/rotation re-anchor is under way (the reader is put back on its passage by chapter index, which has to still be mounted).

### What is released when a chapter unmounts

`ChapterSection`'s effect cleanup (it already existed, but no chapter ever unmounted) stops the table adapter watching the chapter's tables and the
image controller watching its pictures. New: the image controller **holds** the chapter's pictures in the `ImageStore` for as long as it is mounted
(`ImageStore.hold`); when the last holder lets go the picture is released after a 1.5 s grace period - its downscaled blob: URL revoked, its entry forgotten, a downscale
still in flight discarded - so the number of live blob: URLs follows the window, not the book (121 -> at most 16 above). The grace period is there because a
chapter that unmounts in the same commit as another that shows the same ornament mounts must not pull it from under the newcomer. The chapter comes back by being loaded again:
its sanitized HTML registers its pictures afresh and the sanitizer stamps their width, height and aspect ratio again, so a remounted chapter is the same height as when
it was first read (compared in Chromium: 0 px difference) and its tables are adapted again.

### `content-visibility: auto` (evaluated, not adopted)

`.chapter { content-visibility: auto; contain-intrinsic-size: auto 1500px }`, same harness, with and without:

| | without | with |
| --- | --- | --- |
| unbounded page (before Phase 1a), 10.7M px EPUB: fling max gap / gaps over 50 ms | 550 ms / 21 | 67 ms / 3 |
| ... and the blank past 2^23 px | 17 of 72 blank | **still blank** (2 of 39, from y = 8,433,874) |
| ... page height as measured | 10.74M px | 0.37M px at open, growing as chapters render (the scroll height lies until they do) |
| unbounded page, 3,000-page PDF: median p95 frame gap / gaps over 50 ms / traverse time | 17 ms / 6 / 73 s | **83 ms / 153 / 278 s** |
| bounded window, ordinary EPUB: time to first text | 282 ms | 351 ms |
| bounded window, 10.7M px EPUB, continuous traverse | 10.74M px, 0 stalled frames, 0/72 blank | **ended at 3.03M px of 10.74M with 225 stalled frames**: the page kept running out of mounted chapters |

It cuts layout cost on a huge page, which is why the unbounded 10.7M px book flings better with it, but it does not fix the paint limit, it makes the PDF page
much slower, and it makes the heights the window policy relies on wrong (an off-screen chapter measures as its 1,500 px stand-in), which in the bounded window left the
reader repeatedly out of chapters. Once the page is bounded there is no layout cost left for it to save (flings were already at one frame). Not kept.

### PDF: not changed, and has the problem above about 4,250 text pages

A PDF's text pass streams every page and `PdfPageLoader` assumes pages are only ever appended, so it keeps all pages mounted: 3,000 dense text pages are 5.93M px
and 4,500 are 8.89M px, blank from y = 8,400,000 (see above). The same window would work for it (`planWindow` does not care what a chapter is), but it needs random access to
page text (`PdfHandle.loadChapter`), and `PdfPageLoader` to register and release pages per chapter instead of scanning an ever-growing list. That is the lazy PDF text of Phase 1b,
which this task says not to start, so it is left as is and reported here. A scanned PDF has the same problem past about 18,900 pages.
