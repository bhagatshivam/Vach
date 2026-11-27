# Phase 1b: what a long PDF costs the reader, and what a warm reopen costs (measured), before any change

Phase 1a bounded EPUB and Word mounting and left PDF alone: a PDF still extracts the text of **every page** (in the background, from
page 1), mounts every page, and a long enough one builds one huge page (blank past about 4,250 dense text pages). This is the baseline
for Phase 1b, taken on unmodified `main` (5fbeaba), before any product change, to decide what is worth building.

## How it was measured

`scripts/verify/pdf-measure-chromium.mjs`: headless Chromium, 360x800 at DPR 2.75, touch, **CPU throttled 4x**, the REAL reader, REAL
pdf.js (worker included) and the real EPUB opener. Only the native file bridge is faked, by HTTP range requests to the harness, so a 100 MB
file is never held in the page; every call and byte is counted, and can be given a delay. Books (`scripts/verify/gen-pdfs.mjs`,
`scripts/bench/gen-fixtures.mjs --big`, deterministic, never committed):

| Book | What it is |
| --- | --- |
| text-1000 / 3000 / 4500 | 1,000 / 3,000 / 4,500 dense text pages (about 2,400 characters each), with a 20-30 entry outline, 1.4 / 4.3 / 6.5 MB |
| scans-100mb | 300 pages, each one full-page picture of incompressible noise, 98 MB, **classic cross-reference table** |
| scans-modern | the same, with the cross-reference in object streams (what most producers write today) |
| epub-a | the Phase 1b EPUB: 1,500 chapters, 4 MB (read whole, then opened with JSZip) |
| epub-d100 | 98 MB EPUB with pictures (opened by ranged reads of the ZIP's central directory) |

Numbers per book: time to first text; time until every page's text is extracted; JS heap; **total memory** (resident size of every
browser process, against 421-432 MB for the idle browser with the page loaded); renderer CPU seconds from tap to settled; DOM nodes; page
height; frame gaps in ten 30,000 px flings at 300 px per frame (about twice a hard swipe); a continuous traverse checking painted pixels;
far Contents jumps; and a reopen in the same page (saved position mid-book), with the native round trip at 0 and 5 ms per call. This is
desktop Chromium, not a phone: compare the two columns of a table with each other.

## Baseline (main, 5fbeaba)

| Book | first text | all text extracted | pages mounted / DOM nodes | page height | JS heap / total memory | CPU, tap to settled | fling gaps: max / p95 / over 50 ms | reopen at a saved page (0 ms / 5 ms bridge) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| text-1000 | 575 ms | 10.3 s | 1,000 / 6,015 | 1.99M px | 6.1 MB / 632 MB | 15.6 s | 50 / 17 / 0 ms | **4.6 s** / 5.5 s |
| text-3000 | 719 ms | **33.7 s** | 3,000 / 18,015 | 5.97M px | 9.4 MB / 851 MB | 47.1 s | 67 / 17 / 6 ms | **4.6 s** / 3.9 s |
| text-4500 | 752 ms | **58.9 s** | 4,500 / 27,015 | **8.95M px** | 11.7 MB / 1,003 MB | 79.4 s | 117 / 17 / 10 ms | **4.8 s** / 4.8 s |
| scans-100mb (classic xref) | 3.1 s | 4.7 s | 300 / 917 | 0.13M px | 5.1 MB / 747 MB | 9.8 s | 150 / 100 / **218** ms | 4.3 s / 4.5 s (98 reads, 102 MB) |
| scans-modern (object streams) | 1.1 s | 7.8 s | 300 / 917 | 0.13M px | 5.1 MB / 756 MB | 13.8 s | 167 / 117 / **250** ms | **7.4 s** / 7.4 s (98 reads, 102 MB) |
| epub-a (1,500 chapters, 4 MB) | 845 ms | n/a (window) | 3 / 77 | 0.01M px | 4.7 MB / 458 MB | 3.9 s | 50 / 17 / 1 ms | 604 ms / 628 ms |
| epub-d100 (98 MB) | 574 ms | n/a (window) | 3 / 79 | 0.02M px | 4.0 MB / 454 MB | 3.4 s | 33 / 17 / 0 ms | 458 ms / 576 ms |

(The reopen of a scanned PDF at "page 500" of 300 lands on the last page, which is why it reads the whole file.)

**Far Contents jumps and the wait bar** (text PDFs; the reader waits for the text pass to reach the page, with the "Getting to ..." bar):

| | right after opening: to the last entry | later (the text pass still running) |
| --- | --- | --- |
| text-1000 | **13.2 s**, bar shown | 67-70 ms for pages the pass had passed |
| text-3000 | **timed out at 120 s**, bar shown | 0.16 s (passed), **44 s** (bar), 0.17 s, **27 s** (bar) |
| text-4500 | **timed out at 120 s**, bar shown | 0.2 s twice (passed), **timed out** twice (bar) |

**The blank**: a continuous traverse of text-4500 (8.95M px) paints **5 of 58 screens blank, the first at y = 8,398,086**; text-3000 (5.97M px)
is fine. (Same cliff as the EPUB in Phase 1a; see `docs/phase1-measure.md`.)

**The part of opening a metadata cache could skip** (index only, `index` in the JSON; native round trip 0 / 5 / 20 ms per call):

| Book | what is read and parsed | time | bridge reads |
| --- | --- | ---: | ---: |
| epub-a | JSZip loads the 4 MB file, then OPF and the nav document (1,500 entries) | open 461 / 363 / 442 ms + table of contents 87 / 86 / 137 ms | 4 reads, 4.1 MB |
| epub-d100 | central directory (600 entries) from the tail, OPF, nav | open 170 / 191 / 272 ms + table of contents 36 / 38 / 49 ms | 4 reads, 1.6 MB |
| text-1000 / 3000 / 4500 | pdf.js: cross-reference table and page tree, then the outline | open 323 / 537 / 775 ms + outline 12-119 ms | 2-7 reads |
| scans-100mb (classic xref) | pdf.js reads the **whole file** to open it | open **2.5 s** | **98 reads, 102 MB** |
| scans-modern | first MiB and the end of the file | open 236 ms | 2 reads, 1.7 MB |

## What the numbers say

1. **Extract-all is slow and heavy, and the reopen is the worst of it.** All text of a 1,000-page PDF takes 10 s (15.6 CPU seconds at 4x), 3,000
   pages 34 s, 4,500 pages 59 s; the tab holds 6,000 to 27,000 DOM nodes and 200 to 580 MB more than the idle browser. Reopening a PDF at a
   saved page re-extracts every page before it: **4.6 s to first text for a 1,000-page book**, against 0.4-0.6 s for an EPUB.
2. **A far Contents jump waits for the text pass**: 13 s right after opening a 1,000-page PDF, and minutes (timed out at 120 s) on a 3,000-page one.
3. **The blank is real for PDFs at about 4,250 dense pages** (8.95M px, blank from y = 8,398,086). The user's PDFs (at most about 1,000 pages) are far from it; this is
   correctness on giant PDFs, second.
4. **Scanned PDFs**: first text takes 1-3 s and the whole file is read through the bridge while the text pass classifies pages (98 reads, 102 MB; resident
   memory 330 MB over idle for a 98 MB file); flings stutter (218-250 gaps over 50 ms) while pages are rasterized.
5. **The cache** (Phase 1b item 3): see the decision below.
6. **pdf.js needs the whole file's address space** (a full-length buffer in its worker): total memory above is 330 MB over idle for a 98 MB scan, about 3.3x the
   file with everything touched. Not changed in this phase; what it costs after lazy extraction is reported with the results.
7. A classic (non-object-stream) cross-reference makes pdf.js read the **whole file just to open it** (scans-100mb: 98 reads, 2.5 s); a modern one reads
   1.7 MB. That is pdf.js's behaviour, not something this app can change, and it bounds what lazy extraction can save on such a file.

## Decisions the numbers justify

- **Lazy per-page text (item 2): justified.** 10-59 s of extraction and 15-80 CPU seconds, 4.6 s reopen at a saved page, 13 s to minutes for a far jump, up to
  580 MB of memory, and the blank past about 4,250 pages. Build it.
- **Metadata cache (item 3): not justified; not built.** Warm reopen of an EPUB is 0.46-0.60 s in all, of which the part a cache could skip is 0.2 s (98 MB EPUB:
  170 + 36 ms) to 0.55 s (4 MB EPUB, where JSZip must still load the whole file to read any chapter, so a cache would save only the 87 ms table of contents). A PDF's
  reopen is dominated by extraction (4.6 s), which lazy pages remove, and what is left is pdf.js opening the document, which no cache can skip (323-775 ms) -
  the outline (12-119 ms) is already off the critical path. A cache would also need a file modification time the app does not have (`LibraryFile` carries no
  `lastModified`: it would take a native change that cannot be tried here), so a stale entry could not be detected as the key requires. About 0.2 s on one
  kind of book is not worth that.
