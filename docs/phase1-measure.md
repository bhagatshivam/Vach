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
