# Vach (वाच) — Upgrade Blueprint & Build Guide (v3)

**Goal:** Upgrade Vach into a fast, 100% offline, ad-free Android reader for EPUB, PDF and Word (`.docx`) — with reliable huge-book performance, safe image rendering, adaptive zero-overflow tables, and clean Devanagari/Unicode typography.

**How to use this file:** It is the single source of truth for the upgrade. Work one phase at a time, in the order given in section 3 (not the phase numbers). Each phase has build steps and an acceptance checklist. Do not start a phase until the previous one is merged.

---

## 0. Ground Rules (apply to every phase)

1. **Verify, don't assume.** File names in this guide (`libraryFolder.ts`, `readerAnchor.ts`, `readerSettings.ts`, `ReaderScreen.tsx`) come from planning notes, not from the code. Read the real code first; adapt the plan to what exists.
2. **One phase = one branch = one PR.** Branch name `upgrade/<phase-name>`. Small commits. Commits are authored under the repo owner's configured git identity, with Claude Code listed as co-author via the standard `Co-Authored-By` trailer.
3. **Fixed test set (real files from the owner's library).** Record the file names in `docs/test-set.md` during Step 0. Every phase is checked against these, on a real phone, not only in unit tests:

   | ID | File | What it stresses |
   | :-- | :-- | :-- |
   | T1 | The 246-page text-bearing light novel PDF | PDF reflow, M2a, M2b |
   | T2 | A ~1,000+ chapter webnovel EPUB | Chapter count, memory, scroll |
   | T3 | A table-heavy EPUB (LitRPG stat sheets etc.) | Table engine |
   | T4 | An illustrated EPUB (maps, full-page art) | Image pipeline, lightbox |
   | T5 | A Marathi/Hindi/Sanskrit text file (EPUB or PDF) | Devanagari rendering |
   | T6 | The largest PDF in the library | Byte-range reads, memory |
   | T7 | A `.docx` manuscript (with headings, tables, images) and a heading-less `.docx` | Phase 2 |

4. **Definition of done for every phase:**
   - Unit tests pass (Vitest) and the app builds in the GitHub Actions pipeline.
   - Relevant test-set books checked on the real phone (open, scroll, change font size, rotate, switch theme, close, reopen — saved position must restore correctly).
   - `readerAnchor` regression check on at least T2 and T3 after font-size change and rotation.
   - **Release APK size recorded** before and after (add a size line to the CI workflow output) and noted in the PR description.
   - No new network access: CSP still `connect-src 'self'`, no remote fonts/scripts/CDNs.
5. **Anti-bloat (do not build):** no AI/LLM features, no accounts, no cloud sync, no telemetry, no 500-setting menus. Anything not in this guide goes to the backlog (section 11), not into a phase.
6. **Performance targets are measured, not promised.** No fixed millisecond claims. Targets are: fast first text, background indexing, warm reopen from cache with saved anchor, and no UI freezes while scrolling. Phase 1 defines the measurements.

---

## 1. Engineering Constraints

| Area | Rule | How Vach enforces it |
| :-- | :-- | :-- |
| Performance | Fast first text; TOC/metadata/search index build in the background; warm reopen restores from cache + saved anchor. | Chunked native byte reads, IndexedDB cache, off-thread decompression, lazy per-chapter main-thread mounting. |
| Threads | **Never touch DOM APIs in a Web Worker** (no `document`, no `DOMParser`, no DOMPurify). **Capacitor plugin calls are main-thread only.** | Worker: ZIP decompression, PDF text/operator extraction, search. Main thread: plugin byte reads (then transfer the `ArrayBuffer` to the worker), DOMPurify, table adaptation, DOM mounting. |
| Images | No OOM, no scroll jumps, safe on all screen sizes and Night Mode. | Aspect-ratio stamping before mount, viewport-capped downscale, blob URL revocation, tap-to-zoom lightbox. |
| Tables & text | No `.scroll-x` traps; no text-node mutation. | Measured adaptive table engine (re-measured on settings/size change), stacked cards for simple wide tables, lightbox grid for complex ones, pure-CSS wrapping. |
| Offline & size | Zero network calls, lean APK. | Strict CSP, subsetted bundled fonts, APK size check on every phase. |

---

## 2. Step 0 — Audit & Baseline (read-only first, then fix what it finds)

Do this before writing any cache, worker or lazy-ZIP code. Produce a short report `docs/step0-audit.md` and commit it.

### 2.1 Audit questions (answer from the real code)

1. How do bytes get from Android SAF (`ContentResolver`) into JS today? If it is `Filesystem.readFile` or any call that returns Base64 for the whole file, that is the bottleneck: a 400 MB PDF becomes a ~533 MB string that is serialized across the bridge and can OOM the app before pdf.js or JSZip sees it. JS-side lazy loading cannot fix this.
2. How does `libraryFolder.ts` scan, filter extensions, and cache results?
3. How does `readerAnchor.ts` store and restore position (offset? paragraph id? chapter + offset)? What breaks when font size or window size changes?
4. How are chapters mounted today (all at once? appended lazily?) and how are images created (data URLs? blob URLs?)?
5. Does a Table of Contents drawer already exist? Is there in-book search?
6. Is the Android `INTERNET` permission declared in the release manifest? If the app works without it (test it), remove it for release builds so "zero network" is enforced by the OS, not just by CSP. Keep it only for debug/live-reload if needed.
   > **Closed — see A8.** The permission is already absent and CI-verified.
7. Record the baseline APK size.

### 2.2 Baseline measurements (on the real phone, using T1, T2, T6)

Use Chrome remote debugging (`chrome://inspect`) and `adb shell dumpsys meminfo <package>`. Record in the audit report:
- Cold open time to first visible text, and warm reopen time.
- Peak memory (PSS) while opening and after 5 minutes of scrolling.
- Scroll smoothness (dropped frames) on T2.
- Whether any file fails to open at all.

### 2.3 Fix the byte bridge if the audit says it is needed

**Preferred (simplest): chunked reads through a small native plugin method.**
- Add `readChunk(uri, offset, length)` to the SAF plugin. Native side uses `ContentResolver.openFileDescriptor(uri, "r")` with seeking, returns one slice (start with ~1–2 MB, tune after measuring). Base64 on a small slice is acceptable.
- Also expose `getSize(uri)`.
- Main thread calls it and transfers the resulting `ArrayBuffer` to the worker.
- pdf.js: use `PDFDataRangeTransport` (implement `requestDataRange(begin, end)` by calling `readChunk` and answering with `onDataRange`) so a large PDF only pulls the bytes for the pages in use.
- EPUB/DOCX: read the ZIP end-of-central-directory (last ~64 KB), parse the central directory, then read only the byte ranges of requested entries.

**Alternative (more native code): local HTTP-style range handler** via `shouldInterceptRequest` (note `WebViewAssetLoader` does not do Range for you — you must return `206` responses with `Content-Range` yourself). Its one advantage is that Web Workers can `fetch` it directly. Only choose this if the chunked method proves too slow in measurements.

**Acceptance for Step 0:** report committed; T6 opens without memory spikes proportional to file size; T1 still renders exactly as before; APK size recorded.

> **Amended — see A1.** The "no memory spikes proportional to file size" criterion is superseded: after the bridge fix, memory for a huge PDF should be about 1× the file size, not 6–8×.

---

## 3. Run Order (by dependency)

> **Superseded — see A9 for the current run order.** The table below is the original order, kept for reference.

| Order | Work | Why here |
| :-- | :-- | :-- |
| 1 | **Step 0** — audit, baseline, byte bridge fix | Everything else depends on safe byte access and a baseline to compare against. |
| 2 | **Phase 4** — tables, clean text, Devanagari | Quick visible win, low risk, and `.docx` output depends on `tableAdapter`. |
| 3 | **Phase 3A** — image pipeline + lightbox | `.docx` output depends on it; it also upgrades the lightbox shell that Phase 4 created for Expand Grid. |
| 4 | **Phase 5a — TOC drawer** *(only if Step 0 found none)* | Daily-use value; also needed for `.docx` heading slices to be useful. |
| 5 | **Phase 2** — `.docx` support | Reuses the table and image pipelines. |
| 6 | **Phase 1** — speed (cache, worker, gated virtualization) | Done after measuring again with the new formats and pipelines in place. |
| 7 | **Phase 3B** — PDF M2b spike (time-boxed) | Isolated experiment; safe fallback already exists. |
| 8 | **Phase 5b — search** | Needs the worker and the chapter index from Phase 1. |
| 9 | Backlog (section 11) | Only what the owner actually misses while reading. |

---

## 4. Phase 4 — Adaptive Tables, Clean Text & Devanagari

**Goal:** Remove horizontal scrolling for tables and long strings while keeping the text DOM untouched, and render Devanagari and special characters sharply.

> **Amended — see A4 (`.scroll-x` removal, anchor versioning, re-anchoring) and A5 (woff2-only fonts, APK baseline).**

### 4.1 Measured adaptive table engine — `src/lib/tableAdapter.ts`

Runs **on the main thread**, per chapter, right after sanitization and before/at mount. No fixed column-count thresholds.

1. **Normalize:** strip rigid publisher attributes and styles: `width`, `min-width`, `nowrap`, fixed pixel font sizes, hard-coded white/black cell backgrounds (they break Night Mode). Use neutral borders `rgba(128,128,128,0.35)` so tables look right on every theme.
2. **Complexity check (critical guard):** if the table has `colspan`, `rowspan`, nested tables, or `<th>` cells inside `<tbody>` — **never flatten to cards.** Mark it `.vach-table-complex`:
   - If it fits the screen at compact styling, render it normally.
   - If it still overflows, replace it with a small placeholder card ("Table · N rows × M columns") with an **Expand Grid** button.
3. **Header detection** for simple tables, in this order: `<thead>`; else a first row made entirely of `<th>`; else no header. **No header → no cards.** Use compact styling, and if it still overflows use the Expand Grid placeholder.
4. **Measure, then decide (read all, then write all, inside one `requestAnimationFrame`, to avoid layout thrash):**
   - *Fits* (`table.scrollWidth <= container.clientWidth`): full width, `table-layout: auto`, reader font size.
   - *Tight:* apply compact class (smaller padding, `font-size: clamp(0.78em, 2.8vw, 0.92em)`) and **measure again**.
   - *Still overflows after compact:* stamp `data-label` (from header text) on every `<td>` and apply `.vach-table-cards` (each `<tr>` becomes a bordered key-value card). Show a small **Expand Grid** button.
5. **Measure only when needed:** measure a chapter's tables when the chapter mounts or comes into view (IntersectionObserver). Reading layout inside off-screen `content-visibility: auto` chapters forces layout of skipped content and is costly.
6. **Re-run on change, never cache across them:** the decision depends on font size, margins, orientation and foldable/tablet width. Re-evaluate for mounted chapters when reader settings change or a `ResizeObserver` on the reader container fires (debounced). Add a little hysteresis so a table does not flip between modes on tiny size changes.
7. **Expand Grid:** opens a clone of the original table in a full-screen overlay. Phase 4 runs before the full lightbox exists, so build `ImageLightbox.tsx` here as a **minimal shell** (dark backdrop, close button, content that scrolls in both axes). Phase 3A then upgrades the same component with pinch-zoom, double-tap, pan and swipe-to-close. This is the one place sideways movement is allowed, because the reader chose it.

### 4.2 Clean text & special characters (zero DOM mutation)

- **Do not inject `<wbr>`** or otherwise split text nodes (breaks future search highlighting and range matching).
- CSS only, in `App.css`:
  - `overflow-wrap: anywhere` on paragraphs, links, table cells.
  - `pre, code { white-space: pre-wrap; overflow-wrap: anywhere; }`
  - `.reader-content { overflow-x: clip; }` as a hard guard.
  - Remove the old `.scroll-x` rules once the table engine replaces them.
- Strip inline `white-space: nowrap` and fixed pixel widths from publisher HTML in the existing DOMPurify config/hook.

### 4.3 Devanagari & symbol fonts (with APK budget)

1. **Test first with the font stack only:** add a Devanagari-capable family after the reading fonts in `readerSettings.ts` and check T5 on the real phone. Many Android ROMs already ship Noto Devanagari as a system fallback.
2. **Bundle only if needed** for consistency (e.g. the app title "वाच" or T5 looks wrong/mismatched): a subsetted **Noto Sans Devanagari** (or Noto Serif Devanagari) in WOFF2, Devanagari + basic Latin/punctuation only.
3. Add targeted symbol subsets **only** if real test books show missing-glyph boxes (□). Never ship full multi-megabyte Unicode fonts.
4. **Budget:** all font additions together stay under ~1–1.5 MB. Record APK size before and after.

### 4.4 Tests & acceptance

- Vitest fixtures for `tableAdapter`: simple 3-col, simple 8-col, colspan table, rowspan table, nested table, headerless table, `<th>` in tbody, publisher-styled table with fixed widths and white backgrounds.
- On the phone: T3 shows no horizontal scroll on any table in portrait and landscape; changing font size re-adapts tables without leaving the chapter; complex tables show the Expand Grid placeholder and open correctly.
- T5 renders Devanagari without tofu boxes or wrong fallback fonts.

---

## 5. Phase 3A — Image Pipeline & Lightbox (EPUB, DOCX, PDF M2a)

**Goal:** Clean images on every screen size, safe RAM use, no layout jumps, Night Mode safe.

> **Amended — see A3.** The `blob:` URL approach below requires changing the CSP and the DOMPurify `src` hook; both currently block `blob:`.

### 5.1 `src/lib/imageProcessor.ts`

- Decode with `createImageBitmap()`. Downscale anything wider than `Math.min(viewportWidth * devicePixelRatio, 1600)` using `OffscreenCanvas`, output WebP/JPEG. Skip the work for images already small enough.
- Serve via `URL.createObjectURL(blob)`. **Revoke** when the book closes (and later, when far-off chapters unmount, if Phase 1 enables virtualization).
- **Always stamp `width`, `height` and `style="aspect-ratio: W / H"`** on `<img>` before mount so loading never shifts text. For SVG, read the `viewBox` and keep it.
- **Keep a reference to the original source** (archive entry / byte range), not the downscaled blob.

### 5.2 CSS (`App.css`)

`.reader-content img { max-width: 100%; width: auto; height: auto; max-height: 82svh; object-fit: contain; display: block; margin: 1.25em auto; }` and `svg { max-width: 100%; height: auto; }` (keep `viewBox`).
- Keep `mix-blend-mode: multiply` for scanned pages on sepia/beige.
- On the night theme: `filter: brightness(0.84) contrast(1.04)` for bright images.

### 5.3 Lightbox — `src/components/ImageLightbox.tsx`

- Upgrade the minimal shell created in Phase 4 (do not create a second component). Pure CSS + Pointer Events, no library. Double-tap zoom, two-finger pinch, drag to pan, swipe down to close.
- **Decision:** on open, **re-decode the original from the archive** (capped to ~4096 px on the longest side to avoid OOM) rather than zooming the 1600 px downscale. Free that bitmap on close.
- Optional **Invert B&W** toggle (dark-mode readers viewing white-background diagrams).
- Must also accept an HTML table clone (for Expand Grid) with two-axis pan/zoom.

### 5.4 Acceptance

T4 images never shift text while loading; no crash with 4000×6000 images; Night Mode is not blinding; the lightbox opens the full-detail image smoothly; memory returns to baseline after closing the lightbox.

---

## 6. Phase 5a — Table of Contents Drawer *(only if Step 0 found none)*

> **Amended — see A7.** Step 0 found none; this phase is required.

`src/components/TocDrawer.tsx`: normalize EPUB (`nav.xhtml` / `toc.ncx`), PDF (`pdf.getOutline()`), and DOCX (`<h1>`–`<h2>` slices) into one `TocItem[]` tree. Highlight the current item, show overall progress percentage, tap to jump. If a TOC already exists, only extend it to cover DOCX when Phase 2 lands.

---

## 7. Phase 2 — Offline Word (`.docx`) Support

**Goal:** Read `.docx` with Vach's themes, fonts, continuous scroll and TOC.

> **Amended — see A6.** The extension filter lives in three places and `.docx` must never reach the EPUB parser.

1. **Scanner/UI:** extend `libraryFolder.ts` (and any native extension filter) for `.docx` / `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. Add a `.fmt-badge.docx` style.
2. **Mammoth worker test first.** Try `mammoth` inside `parser.worker.ts`. If any code path needs `window`/`document`, run mammoth on the main thread in an async, chunked flow instead. Either way, **DOMPurify and `tableAdapter` run on the main thread.**
3. **`src/lib/docx.ts`:**
   - `mammoth.convertToHtml({ arrayBuffer }, { convertImage })` — use `convertImage` to turn embedded images into binary `Blob`s (never giant base64 strings) that go through `imageProcessor`.
   - **Virtual chapter slicer** (~80 lines): split at `<h1>`/`<h2>` and feed the headings to the TOC. If there are no headings, split on paragraph boundaries every ~2,500–3,000 words ("Section 1", "Section 2", …).
4. Feed slices into the same continuous-scroll pipeline as EPUB chapters.
5. **Tests:** Vitest fixtures for headings, tables, embedded PNG/JPEG, footnotes, and a long heading-less document.
6. **Acceptance:** T7 opens, scrolls, themes, and restores position like an EPUB; wide Word tables adapt via the Phase 4 engine; images follow the Phase 3A pipeline.

---

## 8. Phase 1 — Huge-Book Speed (measure, then optimize)

**Goal:** Keep 1,500-chapter EPUBs and multi-hundred-MB PDFs responsive without breaking `readerAnchor.ts`.

> **Amended — see A2.** Phase 1 is no longer purely measurement-gated: a mandatory Phase 1b is split out, and a Phase 1c (lazy per-page PDF text) is added. Windowed unmounting (step 6 below) stays gated behind measurements.

1. **Re-measure** with the Step 0 method (T2, T6, T7) now that the new pipelines exist. Optimize only what the numbers show.
2. **`src/lib/bookCache.ts` (IndexedDB via `idb`):** cache `BookIndex` records — title, author, TOC, chapter count, ZIP byte offsets, word count — keyed by `(fileUri, fileSize, lastModified)`. Warm reopen skips re-parsing.
3. **`src/workers/parser.worker.ts`:** receives byte chunks from the main thread, does ZIP decompression and raw text/HTML extraction, returns chapter strings only when requested.
4. **Main thread, lazily per chapter:** DOMPurify and `tableAdapter` right before mount; use `requestIdleCallback` in small chunks when prefetching the next chapter.
5. **Cheap rendering win first:** `content-visibility: auto; contain-intrinsic-size: auto 800px;` on chapter containers, with lazy chapter appending (no unmounting). Verify scroll anchoring still behaves with `readerAnchor`.
6. **Virtualization gate (only if measurements demand it):** if profiling still shows memory pressure or jank on T2, add windowed unmounting (active ± N chapters) with locked measured heights, blob URL revocation for unmounted chapters, and thorough `readerAnchor` regression tests. Otherwise do not build it.
7. **Acceptance:** first text appears quickly on T2/T6; warm reopen restores the exact position from cache; memory after 5 minutes of scrolling is no worse than baseline (ideally flat); no UI freezes.

---

## 9. Phase 3B — PDF M2b Spike (embedded images on text pages) — time-boxed

Treat as an isolated experiment. **Time-box it to two working sessions.** If it is not clean on most pages of T1 and two other PDF generators by then, ship only the existing M2a fallback and park M2b.

1. In `src/lib/pdf.ts`, walk `page.getOperatorList()` while maintaining a CTM stack (`OPS.save`, `OPS.restore`, `OPS.transform`) to compute real bounding boxes for `OPS.paintImageXObject` and `OPS.paintInlineImageXObject`.
2. Filter out tiny decorative items (width or height under ~32 pt) and full-page background masks.
3. Interleave extracted bitmaps into the reflowed paragraph stream by comparing the image's Y-bounds with extracted text-line Y-coordinates; route the bitmaps through `imageProcessor`.
4. **Safe fallback:** if the transform math or layout is ambiguous (multi-column spreads, overlapping layers), render that page with the existing M2a rasterized renderer instead of garbling it.
5. Fixtures: T1 plus 2–3 PDFs from different generators.

---

## 10. Phase 5b — Offline In-Book Search

`src/components/SearchSheet.tsx` + search in `parser.worker.ts` over cached plain-text chapter strings (built in the background indexing step). Show short context snippets; tapping a result mounts the target chapter, scrolls to the match and highlights it. Highlighting uses ranges over the untouched text DOM (this is why Phase 4 forbids text-node mutation).

---

## 11. Backlog (out of core scope — build only what is actually missed)

- Pop-up footnotes (bottom sheet for `#fn` / `epub:type="noteref"` links)
- Zen mode: `@capacitor/status-bar` edge-to-edge, `@capacitor-community/keep-awake`
- Per-book font-size/margin overrides; custom `.ttf`/`.otf` font loading from the device
- Cover thumbnails (~300 px WebP in IndexedDB) and a grid view in the library
- Auto-scroll and left-edge brightness swipe
- Bookmarks, highlights, Markdown note export — **this reverses an original non-goal**; add only if Vach should become a study reader

---

## 12. Target Project Structure

```text
src/
├── components/
│   ├── ImageLightbox.tsx      # Pinch-zoom/pan for images + expanded tables
│   ├── TocDrawer.tsx          # Unified TOC drawer (if not already present)
│   └── SearchSheet.tsx        # Worker-backed in-book search
├── lib/
│   ├── bookCache.ts           # IndexedDB cache (metadata, TOC, byte offsets)
│   ├── epub.ts                # Lazy EPUB reader (uses chunked byte reads)
│   ├── pdf.ts                 # Reflow + M2a scanned pages + M2b spike
│   ├── docx.ts                # Mammoth parser + virtual chapter slicer
│   ├── imageProcessor.ts      # Downscaler + blob URL lifecycle
│   ├── tableAdapter.ts        # Main-thread measured adaptive tables
│   ├── libraryFolder.ts       # SAF scanner (.epub, .pdf, .docx)
│   ├── readerAnchor.ts        # Scroll-position anchoring
│   └── readerSettings.ts      # Themes, fonts (+ Devanagari)
└── workers/
    └── parser.worker.ts       # ZIP/PDF/search work, no DOM
docs/
├── test-set.md                # T1–T7 file names
└── step0-audit.md             # Audit + baseline numbers
```

---

## 13. Kick-off prompt template for each Claude Code session

> Read `vach_upgrade_blueprint_v3.md`. We are doing **<phase name>** now. First read the real code for every file this phase touches and tell me where it differs from the blueprint. Then implement on branch `upgrade/<phase-name>`, add the tests listed, and finish with the acceptance checklist, the APK size before/after, and anything you could not verify without the phone. Do not start any other phase.

---

## 14. Amendments after Step 0 audit

These amendments come from the Step 0 audit (`docs/step0-audit.md`, branch `upgrade/step0-audit`). Where they conflict with earlier sections, **these win**; the earlier text is marked "Amended" or "Superseded" in place. Reference baseline: **v1.9.0 `Vach.apk` = 6,103,562 bytes**.

**A1. Step 0 acceptance is reworded (overrides §2.3 "Acceptance for Step 0").** After the bridge fix, memory for a huge PDF should be about **1× the file size**, not 6–8×. It cannot be flat, because the pdf.js `ChunkedStream` allocates a full-length buffer and `streamChaptersImpl` extracts text for every page. Flat memory needs per-page lazy extraction (new **Phase 1c**).

**A2. Phase 1 is no longer purely conditional (amends §8).** Confirmed from code: all chapters stay mounted, each append re-renders the whole list (quadratic), and restoring at chapter N parses chapters 1..N. A new **Phase 1b is mandatory**: an EPUB ZIP central-directory reader, restoring directly to the saved chapter, and a memoized chapter list so appends do not re-render existing chapters. Windowed unmounting stays gated behind measurements.

**A3. Phase 3A must change the CSP and the DOMPurify `src` hook (amends §5).** Add `blob:` to `img-src` (it is local; no network), and update the `src` hook, because both currently block `blob:` URLs.

**A4. Phase 4 anchors and `.scroll-x` (amends §4.1, §4.2).** `.scroll-x` is also created in `epub.ts` and special-cased in `readerAnchor.ts`; removing it shifts `blockIndex`. Add an **anchor version field**; old anchors fall back to chapter start. Also add **explicit re-anchoring** on font-size change, rotation and table re-adaptation (capture the anchor before, restore after), since nothing does this today.

**A5. Phase 4 fonts (amends §4.3).** Ship **woff2 only** (drop the redundant `.woff` files, about 1.2 MB). Verify woff2 support against the app's minimum WebView first. Use the savings to fund Devanagari. APK baseline: **v1.9.0 `Vach.apk` = 6,103,562 bytes**.

**A6. Phase 2 extension filter (amends §7).** The `.docx` extension filter is in three places: `LibraryFolderPlugin.kt`, `libraryText.ts`, and `openBookStream`. Update all three, and make sure `.docx` is never routed to the EPUB parser.

**A7. Phase 5a (amends §6).** TOC is confirmed absent, and in-book search is also absent.

**A8. Step 0 item 6 is closed (amends §2.1).** The `INTERNET` permission is already absent and CI-verified for both debug and release builds.

**A9. New run order (supersedes §3):**

1. Byte bridge
2. Phase 1b
3. Phase 4
4. Phase 3A
5. TOC (Phase 5a)
6. Phase 2 (`.docx`)
7. Phase 1c: lazy per-page PDF text + cache, if measurements justify
8. M2b (Phase 3B)
9. Search (Phase 5b)

### Phase 1b result (amendment A2)

**What changed**
- **Lazy opening.** An EPUB is opened as an `EpubBook` (`epub.ts`): only the container, OPF and spine are read up front; a chapter is decompressed and sanitized only when `loadChapter(i)` is called. The reader opens at the saved chapter (minus one chapter of context) without parsing chapters before it, and loads earlier chapters as the reader scrolls up, putting the view back exactly where it was after each insert (measured on the chapter element, so it is correct with or without the browser's own scroll anchoring).
- **Central-directory ZIP reader** (`zipReader.ts`): reads the end-of-central-directory record from the tail, indexes the central directory, and reads and inflates single entries on demand (stored and deflate; ZIP64, multi-part, encryption and other methods fail with a clear message). Inflate uses the platform `DecompressionStream('deflate-raw')`: no new dependency and no bundle bytes, offline, off the main thread, and the app's own build target (Vite's default, Chrome 111) already exceeds the Chrome 103 it needs. Small reads are served from a block cache (1 MiB blocks, 8 kept) because chapters are small and stored in order.
- **Size threshold: 16 MiB** (`EPUB_WHOLE_FILE_MAX_BYTES`, `epubFile.ts`). Up to it, the file is read once with `readAll` and opened with JSZip, exactly as before; above it, the ranged reader is used. Both feed the same `openEpub`, so what the reader shows is identical either way (pinned by a parity test). 16 MiB is the suggested starting point, not a measured optimum.
- **Chapter list.** Chapters are memoized components keyed by their book index; appending or prepending never re-renders or touches mounted chapters (render-count tests), and streamed-in chapters are committed in batches (at most every 100 ms) instead of one update each.
- **Saved positions need no migration.** The stored anchor `{ chapterIndex, blockIndex, blockFraction }` was already chapter-relative (`blockIndex` counts blocks inside one chapter), so old positions are used as-is; a test pins the on-disk format. Positions are saved in book terms and progress / "chapter X of Y" use chapter indexes, never DOM order. The anchor *version* field from A4 is still due in Phase 4, when `.scroll-x` changes block structure.
- Chapter indexes are positions in the spine after dropping entries missing from the archive (as before), so they still match positions saved earlier. `total` is now that count rather than the raw spine length.

**Still not done**
- Lazy per-page PDF text (**Phase 1c**): a PDF still extracts every page in order, and restoring at page N still extracts pages 1..N. Memory for a huge PDF is still about 1× the file.
- No persistent cache (`bookCache`) and no parser worker; EPUB parsing and sanitizing still run on the main thread.
- Chapters after the saved one are still streamed in and kept mounted (windowed unmounting stays gated behind measurements).
- Not verified on a phone: speed of a late restore on a very long EPUB, scroll smoothness while earlier chapters load, and the 16 MiB threshold.

### Phase 4 result (amendments A4, A5; blueprint section 4)

**What changed**
- **Table engine** (`tableAdapter.ts`): after a chapter mounts and is near the viewport, each table is normalized (publisher widths, heights, nowrap, fixed type sizes and white/black cell colors stripped) and measured at its natural width with words unbreakable. It is shown **normally** if it fits, **compact** if it fits smaller, **cards** (label/value, from the header) if it is simple with a header and still too wide, or **collapsed** to a "Table, N rows x M columns" strip with **Expand Grid** otherwise. Anything with `colspan`/`rowspan`, a nested table, `<th>` outside the header row, or a multi-row `<thead>` is complex and is **never** turned into cards. Reads and writes are batched (two layouts per pass); the decision is re-run on every font-size/line-height/theme change and on a width change (debounced `ResizeObserver`), with 12 px of hysteresis so a table does not flip modes on a one-pixel change. Expand Grid opens a clone in `ImageLightbox.tsx`, a minimal shell (dark backdrop, close button, a panel that scrolls both ways); hardware Back closes it first. No zoom: that is Phase 3A.
- **`.scroll-x` is gone** (epub.ts, readerAnchor.ts, CSS). Reading positions are unaffected, by proof rather than by migration: the old wrapper div was itself the leaf block where the `<table>`/`<pre>` now is, one block each, and neither was ever descended into, so every `blockIndex` counts identically. `readerAnchor.test.ts` reproduces the old algorithm verbatim and checks 16 chapter structures (tables and `<pre>` at every nesting) against the new one. The table's placeholder and Expand Grid button live inside the table (a leading `<caption>`), so a table is one block in every display mode. Even so, saved anchors now carry `anchorVersion` (2; unversioned = 1, restored as-is because it is equivalent); a version this build does not know restores to the start of the saved chapter, never a wrong paragraph.
- **Re-anchoring**: before a font-size, line-height, font-family or theme change, and from a cached position for a rotation or resize, the reader captures its anchor, waits for fonts, re-adapts the tables, and scrolls back to the same passage (checked again two frames later). Table adaptation that runs while reading is wrapped the same way, so a table above the screen turning into cards does not move the text. There is no margin setting yet; when there is, it belongs in `settingsAffectLayout` (`reanchor.ts`).
- **Clean text** (CSS only): `overflow-wrap: anywhere` on paragraphs, list items, quotes, headings, links, captions and cells; `pre, code { white-space: pre-wrap }`; `.reader-content { overflow-x: clip }`. No `<wbr>`, no split text nodes. The sanitizer also drops `width`/`height` on table elements.
- **Fonts**: `@fontsource`'s `.woff` fallbacks are gone (`src/fonts.css`, generated by `scripts/fonts/generate-fonts-css.mjs`, woff2 only; woff2 is supported since Chrome 36 and the app's build target is Chrome 111). The web bundle falls from 4,427,917 to 3,196,597 bytes (-1.23 MB). Every reading-font stack now names Devanagari-capable families (Noto Serif/Sans Devanagari, Nirmala UI, Mangal) after the reading font. **No Devanagari font is bundled**: the sandbox has Devanagari system fonts, so a rendering test here proves nothing about a phone; the sample book is the real test, and the plan if it shows boxes is one subsetted Noto Devanagari woff2 (Devanagari + basic Latin + punctuation) within the 1 MB budget the removed `.woff` files freed.
- **Sample books** (`samples/`, generated by `scripts/samples/gen-samples.mjs`): `tables-sample.epub` (every table shape plus long unbroken strings) and `devanagari-sample.epub` (Marathi, Hindi, Sanskrit, symbols).
- **Verification**: `scripts/verify/tables-chromium.mjs` loads the sample through the real sanitizer, CSS and adapter in headless Chromium at 360, 412 and 780 px and at 14, 18 and 28 px type: no horizontal overflow anywhere, the reading blocks identical in every mode, and the reader stays on the same passage after a font-size change.

**Still not done**: Expand Grid has no zoom or pan (Phase 3A); no Devanagari font bundled (see above); not verified on a real phone or Android WebView (layout, Devanagari glyphs, touch targets, rotation feel).

### Phase 3A result (image pipeline and lightbox)

**What changed**
- **No more `data:` URLs.** Every picture is a `blob:` URL (`imageProcessor.ts`, `ImageStore`). CSP is `img-src 'self' data: blob:`; `connect-src` is untouched and nothing is fetched. DOMPurify's `src` is allowed only if it is one of the store's own live blob URLs (`isOwnBlobUrl`, `#fragment` ignored): a book cannot name any other `blob:`, `data:`, `http:` or `file:` source. `ALLOWED_URI_REGEXP` is `/^blob:/i`, and an `uponSanitizeAttribute` hook is the real gate (DOMPurify's default data-URI allowance for `<img>` would otherwise let `data:` through). Every `<img>` gets `loading="lazy"` and `decoding="async"`; nothing else gets them.
- **Sizes before mount** (`imageSniff.ts`): a synchronous header read (PNG, JPEG incl. EXIF orientation, GIF, WebP VP8/VP8L/VP8X, SVG via viewBox/width/height) gives every image its dimensions. The sanitizer stamps `width`/`height` attributes plus inline `width: Wpx; aspect-ratio: W / H` before the chapter mounts, so the box is final from the first frame (the inline width is needed because the 1x1 placeholder would otherwise size it). Truncated or corrupt headers return `null` and the image is simply shown unstamped.
- **Background downscale** (`ImageStore`, `ImageController`): only images wider than `min(viewport width x devicePixelRatio, 1600)` (viewport width when the chapter is mounted) are touched. They start as a shared 1x1 transparent placeholder (`blob:...#vach-<id>`), are processed when they come within 150% of the viewport (IntersectionObserver), at most two at a time (`createImageBitmap` + `OffscreenCanvas`, EXIF orientation honoured, WebP out, PNG if transparent), and the `src` is swapped without moving anything. SVG, animated GIF/APNG/WebP and anything over 150 MP pass through. On any failure the original bytes are used; nothing throws into the reader. The store keeps a reader of the **archive entry** (`source.read()`), never the original blob.
- **Revocation.** `EpubBook.close()` revokes every blob URL (originals, downscaled copies, the placeholder, an open lightbox copy); `ReaderScreen`'s load-effect cleanup calls it. Late jobs after close create nothing; `release()` after `revokeAll()` does not revoke twice.
- **CSS** (`App.css`): `max-width: 100%; width: auto; height: auto; max-height: 82svh; object-fit: contain; display: block; margin: 1.25em auto`, `svg { max-width: 100%; height: auto }`, night theme `filter: brightness(0.84) contrast(1.04)`; inline images in a line of text stay inline. All of it is scoped `:not(.pdf-page-img)`: the PDF M2a page rules (`.pdf-page-img`, `mix-blend-mode: multiply` for scans on sepia/beige, the night dimming) are untouched.
- **Lightbox** (`ImageLightbox.tsx`, one component, pure CSS + Pointer Events, maths in `lightboxGestures.ts`): double-tap zoom, pinch, clamped pan, swipe-down to close (at the fitted size), close button, Escape, hardware Back (via the existing `overlayCloseRef`, which now covers images and tables alike). Tapping a picture in `.reader-content` opens it (not a decoration under 64 px on both sides, not an inline image, not a picture the book did not own). On open the **original** is re-read from the archive and decoded to at most 4096 px on the longest side (`ImageStore.full`); the copy is freed on close. An "Invert" toggle appears for dark themes. Expand Grid tables use the same component, so they now zoom and pan too (they open at their own size).
- **Sample book**: `samples/images-sample.epub` (78 KB, `scripts/samples/gen-images-sample.mjs`, deterministic).
- **Verification**: `scripts/verify/images-chromium.mjs` (real sanitizer, pipeline, CSS and lightbox in headless Chromium at 360, 412 and 780 px).

**Decisions worth knowing**
- The cap uses the page width at the moment a chapter mounts. An image prepared in portrait stays at portrait resolution if the phone is turned (softer in landscape); tapping it opens the full-detail copy. Re-preparing on rotation is possible later.
- No JPEG is in the sample book (there is no JPEG encoder in the generator). JPEG is covered by header fixtures and by the same decode path as PNG.

**Still not done**: not verified on a real phone or Android WebView (decode speed and memory on a low-end device, gesture feel, Back behaviour); PDF page images are unchanged; no persistent image cache.

### Phase 5a result (table of contents drawer; amendment A7, blueprint section 6)

**What changed**
- **One model** (`toc.ts`): `TocItem { id, title, chapterIndex, fragment?, depth, children }`, where `chapterIndex` is the reader's own numbering (EPUB spine index, PDF page index). Pure helpers: `currentTocItem` (the last entry, in document order, whose chapter is <= the current one), `hasDeepNesting` (three levels or more), `fallbackToc`, and `weightedProgress`. A DOCX loader only has to return a `TocItem[]`; nothing else knows about formats.
- **EPUB** (`epubToc.ts`, `epubPath.ts`, `epub.ts`): the OPF now yields the nav document (`properties="nav"`), the NCX (`<spine toc>` or its media type) and the full spine. `EpubBook.toc()` reads **only** that one file (nav preferred, NCX if the nav gives nothing, else one "Section N" per chapter), resolves hrefs against the nav/ncx file (`../`, percent-encoding, malformed escapes kept literally, fragments), and maps each to a spine index. A non-linear spine item opens the nearest chapter after it (else before); an href outside the spine is dropped unless it has children, in which case it opens the first of them; duplicates are kept; empty titles become "Section N". Nothing parses a chapter to build or open the TOC (tests assert the archive reads).
- **Chapter anchors** (`epub.ts`): the sanitizer drops `id`, so fragments had nothing to point at. Each id / `<a name>` is now kept as the inert `data-vach-anchor` attribute (never as an id, so it cannot clobber the page's names). It changes attributes only, never the tree, so block counts, and therefore saved reading positions, are identical (a test compares the output with and without ids). An anchor on an element the allowlist drops (the usual empty `<a id>` in a heading) goes to the nearest surviving ancestor.
- **Progress** is weighted by each chapter's uncompressed size from the ZIP's central directory (`archive.sizeOf`: the ranged reader's index, or JSZip's recorded size), with no parsing; an archive that cannot say, and PDFs, count chapters equally. The same figure feeds the library's progress bars, so the drawer and the library agree.
- **PDF** (`pdf.ts`): `PdfHandle.getOutline()` resolves `pdf.getOutline()` destinations (named, explicit, bare index) to page indexes; unresolvable entries are dropped, a heading with resolvable children opens the first one.
- **Drawer** (`TocDrawer.tsx`, `toc.css`): slides in from the left over a dimmed page, in the reader's theme, padded by the safe-area insets with its background behind the bars; progress percentage and slim bar at the top; the current entry highlighted and scrolled into view; collapse/expand only below the top level and only for a book three levels deep (groups not on the way to the current entry start collapsed). The button is in the reader's top bar, shown only once the book has a TOC with more than one entry.
- **Jumping** (`ReaderScreen.tsx`): a chapter already mounted is scrolled to (the fragment's element if the chapter has it, else the chapter start) and checked again after layout; one outside the mounted window reopens the window at it, exactly as a saved position does (`jump` replaces the saved position for that open; nothing before the target is parsed); the new position is saved; the drawer closes and the top bar hides. Hardware Back and tapping outside close the drawer before the book (the existing `overlayCloseRef`, now covering the lightbox and the drawer).

**PDF decision.** The PDF button is **kept**, because a jump needs no extra extraction: the text pass already runs over every page in order, whatever the reader does. A page that has arrived is scrolled to at once; one that has not shows a small bar ("Getting to ..., page N of M") with Cancel while the pass catches up, and lands when it arrives. Cancel stops waiting (the pass carries on). Lazy per-page text (Phase 1c) would remove the wait; it is not done.

**Not done / caveats**: not measured on a phone (how fast a jump into a far chapter of a very long book lands, since it reopens the window); the highlighted entry is the last one whose chapter is <= the current one, so with several entries in one chapter it is the last of them, not the one nearest the reader; no DOCX loader (Phase 2).

### Phase 2 result (.docx support; amendment A6, blueprint section 7)

**What changed**
- **Library and routing (A6, all three places).** `LibraryFolderPlugin.kt` (`SUPPORTED_EXTENSIONS`, used by the folder scan and by the single-file picker's result filter), `libraryText.ts` (`detectFormat`, `DOCX_MIME_TYPE`) and `openBookStream` in `ReaderScreen.tsx`. A `.docx` is routed to its own opener before the EPUB branch and never reaches the EPUB parser (a test makes the EPUB parser throw and checks it is not called). Legacy binary `.doc` stays unsupported and unlisted. The single-file picker has no MIME list to extend (it is `*/*` on purpose, filtering by extension, because providers mis-tag files); its comment now names the Word MIME type. `.fmt-badge.docx` added. Title: `docProps/core.xml` `dc:title`, else the cleaned file name.
- **Converter: mammoth 1.13.0, BSD-2-Clause.** Its dependencies are MIT or BSD-2-Clause (`@xmldom/xmldom`, `base64-js`, `underscore`, `xmlbuilder` MIT; `dingbat-to-unicode`, `lop` BSD-2-Clause; `jszip` is dual MIT / GPL-3.0-or-later and is already a dependency, used under MIT; `argparse` is MIT and belongs to mammoth's CLI, which is not bundled). It runs in a **Web Worker**: tested first, in headless Chromium, as built by Vite and under the shipped CSP (`worker-src 'self'`); mammoth parses XML with `@xmldom/xmldom`, so it needs no DOM. DOMPurify, the slicer, the table adapter and all mounting stay on the main thread. There is no main-thread fallback (the same-origin module Worker is exactly what pdf.js already needs); a Worker that cannot run gives a plain "could not be read" message. The converter is a lazily loaded chunk (`docxWorker`, 313 KB raw, 96 KB gzip) plus a 5 KB opener; nothing loads until a `.docx` is opened.
- **Pictures** come out of mammoth's `convertImage` hook as bytes (never base64), identical pictures kept once, EMF/WMF/TIFF left out with a warning, transferred from the worker without copying, and go through the existing `ImageStore` (header sniff, size and aspect-ratio stamped before mount, background downscale, lightbox). **Memory choice:** the original bytes of every picture are kept for the life of the book and `ImageStore` re-reads them for the downscale and the lightbox. For the 30 MB image-heavy benchmark that is about 30 MB held, plus up to 30 MB of blob copies for pictures actually shown (about 60 MB steady state); a typical Word file is far smaller. Peak while converting is higher (the file, its copy sent to the worker, the extracted pictures, the transfer): about 310 MB growth across all browser processes in the benchmark.
- **Virtual chapters** (`docx.ts`): a chapter starts at each `h1`/`h2`; text before the first heading is its own chapter (named after the document); with no `h1`/`h2`, paragraph-boundary cuts about every 2,750 words ("Section N", a tiny last section folded into the one before). The TOC is built from `h1`-`h3` (nested by level, with an anchor for `h3`), or the reader's "Section N" list when there are no headings. A bookmark just before a heading goes with the heading. The book implements the same `EpubBook` interface, so restore, the Contents drawer, re-anchoring, tables and images work with no special cases; far TOC jumps follow the PR #12 `MAX_DIRECT_JUMP_OFFSET_PX` rule through the same code path (tested, including the last section of a 100,000-word document).
- **Links and notes.** Ids are kept as `data-vach-anchor` (A: Phase 5a); internal links (footnote and endnote numbers, the notes' back arrows, cross-references) become `<span data-vach-link>` (allowed by the sanitizer, inert) and `resolveLink` names the chapter and anchor; a tap goes through `jumpToTocItem`. A link to an id the document does not have is plain text. No popup sheet yet.
- **Errors**: password-protected or old `.doc` (an OLE container), not a Word file, damaged, and unreadable each have a one-sentence message shown as is; an empty document opens on "This document is empty."

**Measured (sandbox, headless Chromium, 100,000 words and a 30 MB file)**: see the PR. Conversion is under 0.3 s in the worker, the main thread is never blocked (largest frame gap about 20 ms), slicing is 3 to 20 ms.

**Not done / caveats**: not verified on a phone (WebView Worker start, real memory, gestures); links to external URLs are plain text; a Word document with very long sections under one heading is one chapter (no further splitting); a far TOC jump reopens the window, which re-reads and re-converts the document (about 0.1 to 0.3 s in the benchmark); the library lists the file name, not the document's own title.

### Phase 1a result (bounded chapter mounting; blueprint section 8, step 6 - the virtualization gate was met)

The gate "only if measurements demand it" was met by the bug PR #12 found: Chromium paints nothing past about 2^23 px (8.4M) of scroll offset and every chapter after the reader stayed mounted. Measured in `docs/phase1-measure.md` (`scripts/verify/mount-measure-chromium.mjs`, headless Chromium, CPU x4): the 10.7M px book painted blank for 17 of 72 screens of a top-to-bottom traverse, from y = 8,400,080.

**What changed**
- **A bounded window of mounted chapters** (`mountWindow.ts`, `ReaderScreen.tsx`) for EPUB and Word: chapters are loaded ahead of and behind the reader while fewer than 5 screens of mounted text remain beyond the screen, and unmounted (ahead and behind) only while 12 screens would still remain without them, with a hard ceiling of 1.5M px of mounted page. Chosen from the measured on-screen size of the mounted chapters, so a book of 70,000 px chapters mounts 1 and a book of short chapters mounts a dozen. **No placeholder spacers**: the page is exactly as tall as the window. The first window is the saved chapter plus one before it and a few after it, taken from the stream, which is then stopped.
- **Compensation in the same commit**: the prepend compensation became general (`scrollAnchorRef`): the chapter at the top of the screen is measured before chapters are added above it or removed from above it, and put back after (a layout effect, so before paint). The window is left alone while a lightbox / Expand Grid is open and while a font / theme / rotation re-anchor is under way.
- **Release on unmount** (`ImageStore.hold`/`known`, `ImageController.register`): a mounted chapter holds its pictures; the last holder letting go releases a picture after 1.5 s (blob URL revoked, entry forgotten, a downscale in flight discarded), so live blob: URLs follow the window (121 -> at most 16 on a 120-picture book). The EPUB and Word openers' own positive image caches were replaced by `ImageStore.known` (they would have gone stale). The table controller's per-section cleanup (which already existed) now actually runs. A chapter that comes back is loaded and sanitized again, so its pictures are stamped with width, height and aspect ratio again (same height as before: 0 px difference) and its tables adapted again.
- **Progress, the Contents position and the weighted bar** already came from chapter indexes and sizes (`measureAnchor`, `weightedProgress`), never from the scroll height; nothing needed fixing, and tests now pin it for a window that starts deep in the book.
- `MAX_DIRECT_JUMP_OFFSET_PX` (PR #12) stays as a backstop; a jump to a chapter outside the window reopens the window at it, as before.

**Measured** (before -> after, same harness): 10.7M px book: 150 -> 1 chapters mounted, 2,565 -> 33 DOM nodes, 10.74M -> 0.07M px of page (never above 0.14M while read end to end), fling max frame gap 550 -> 17 ms, **traverse 17/72 blank -> 0/72**, first text 388 -> 315 ms (noise is about 100 ms), heap 4.0 -> 3.5 MB. Ordinary 365-chapter book: 365 -> 3 chapters, 4,757 -> 49 nodes. 100,000-word docx: 38 -> 1 sections (first text unchanged: the conversion dominates). Chromium also checks that the text on screen never moves when chapters are mounted or unmounted (220 changes in slow drags, 343 in real compositor flings at 8,000 px/s: 0 shifts), that heap is flat over 21M px of scrolling, and that the Contents jump matrix still passes (562/562).

**Decisions worth knowing**
- `content-visibility: auto` was measured and **not adopted**: on the old unbounded page it cut the 10.7M px book's fling gap (550 -> 67 ms) but left the blank, made a 3,000-page PDF much worse (median p95 gap 17 -> 83 ms, traverse 73 -> 278 s) and made scroll heights unreliable; on the bounded window it saves nothing and misleads the policy (the traverse of the tall book ended at 3.03M px with 225 stalled frames).
- **PDF is not changed and has the same problem** above about 4,250 dense text pages (4,500 pages: 8.89M px, blank from y = 8,400,000) or about 18,900 scanned pages. The window logic is source-agnostic, but a PDF needs lazy page text (`PdfHandle.loadChapter`) and `PdfPageLoader` registering pages per chapter: that is Phase 1b, which was not started.
- The images/tables of a chapter are re-prepared whenever it comes back (read from the archive again), not cached; unmounted chapters' HTML is not kept (only the window's HTML is in memory).
- A far Contents jump (and now any jump beyond about 12 screens of text) reopens the window at the target through the PR #12 path, which for a Word document re-converts it (0.3 s for 100,000 words in the worker). Moving the window in place without reopening the file would be quicker and is a possible follow-up.

**Not done / caveats**: not verified on a phone or in Android's WebView (compositor-fling behaviour with script scrolling there, how fast a chapter is read, sanitized and mounted on a slower CPU against the 5-screen margin, real memory); one chapter that is itself taller than 8.4M px (a whole book in one file would have to be absurdly long) is mounted whole; a picture or table loaded for a chapter that is then discarded before it mounts stays registered until the book closes (bounded, rare).

### Phase 1b result (lazy PDF pages; blueprint section 8 and amendment A2 - the PDF half; the metadata cache was measured and not built)

Measured first, on unmodified main (`docs/phase1b-measure.md`, `scripts/verify/pdf-measure-chromium.mjs`, headless Chromium, real pdf.js, CPU x4): a PDF extracted the text of every page from page 1 (10 s for 1,000 pages, 34 s for 3,000, 59 s for 4,500), mounted all of them (6,000 to 27,000 DOM nodes, 200 to 580 MB over the idle browser), reopened at a saved page in 4.6 s (every page before it first), made a far Contents jump wait 13 s (minutes for 3,000 pages), and 4,500 pages painted blank from y = 8,398,086.

**What changed**
- **Lazy per-page text** (`pdf.ts`, `pdfPages.ts`, `pdfBook.ts`): `PdfHandle.loadPage(i)` extracts one page on demand and nothing is read ahead. `PdfPageExtractor` runs pages one at a time, most urgent first, drops pages that have not started when the reader no longer needs them (`cancelPending`, `PageCancelledError`) and shares a page asked for twice; nothing is cached (the reader holds what it shows). `pdfAsBook` makes a PDF a book of pages (chapter k = page k + 1, equal weights), so the Phase 1a window manager and `mountWindow` policy mount and unmount it like an EPUB: the page stays short however long the PDF is. The stream-everything path of `ReaderScreen` had no user left and is gone.
- **Jumps**: a jump to a page outside the window extracts that page (and its neighbours, the target first), replaces the window and puts the reader at the page by the saved-position path; the document is not reopened and nothing in between is read. The "Getting to ..." bar remains only as a fallback, after 0.4 s.
- **Scanned pages**: `PdfPageLoader.register(section)` / `pause()` / `resume()`; each page registers as its chapter mounts (`PdfPageLoaderContext`, `ChapterSection`) and is released when it unmounts (renders cancelled, observers dropped, picture cleared); nothing renders until the reader is at its place. The scanned-book notice is fed by every page that is loaded.
- **Unchanged**: reflow quality, the image-page fallback, saved positions (page-index anchors; existing ones restore), font/theme re-anchoring, page-based progress.

**Measured** (before -> after): 1,000 text pages: 1,000 -> 4 pages mounted, 6,015 -> 40 DOM nodes, page 1.99M -> 0.01M px, memory after open 632 -> 472 MB (idle 421), far jump right after opening 13.2 s -> 95 ms, reopen at a saved page 4.6 s -> 0.34 s. 3,000 and 4,500 pages: memory after open 851 -> 498 and 1,003 -> 505 MB, far jump > 120 s -> 87 and 98 ms, reopen 4.6 s and 4.8 s -> 0.6 s; flung from the first page to the last and back at 600 px per frame, **0 blank screens each way** (4,500 pages were blank from y = 8,398,086), page never above 18,283 px, 9 pages and 70 DOM nodes at most, 0 stalled frames, heap 4.2 -> 7.2 MB. A 98 MB scanned PDF: pages rasterized as they come near, read through with 0 of 23 screens blank, at most 18 rendered pages held.

**Decisions worth knowing**
- **The metadata cache (`bookCache.ts`) was not built.** Warm reopen of an EPUB is 0.46-0.6 s, of which the part a cache could skip is 0.2 s (98 MB EPUB, ranged) to 0.55 s (4 MB EPUB, where JSZip must still load the whole file, so a cache would save only the 87 ms table of contents); a PDF's cost was extraction (gone now) and pdf.js opening the document (0.3-0.8 s), which no cache can skip; and the key needs a modification time that `LibraryFile` does not carry (it would take a native change). Reopening is now about the same for a PDF as for an EPUB.
- **pdf.js's whole-file buffer is unchanged and costs**: +62 MB over the idle browser to open a modern 98 MB PDF, and about 0.75 GB more once every page has been looked at, in the old reader and the new one alike (an experiment clearing all page pictures and calling `PDFDocumentProxy.cleanup()` freed only 35 MB). A PDF with a classic cross-reference is read whole just to open it (98 reads, 102 MB for the 98 MB scan). Lazy extraction saves the memory of what the reader never goes near, not of what it reads.
- A jump right after opening a scanned book can show the scanned-book notice a few pages later than before (it needs 15 loaded pages, which now means 15 pages read or near, not the first 15 of the file).

**Not done / caveats**: not verified on a phone or in Android's WebView (extraction speed against the 5-screen margin on a slow CPU, rasterizing, memory of a very large scan); the memory after a full read-through of a large scan is pdf.js's and is not reduced.
