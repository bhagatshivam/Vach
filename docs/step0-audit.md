# Step 0 — Audit & Baseline

Read-only audit of the code at `origin/main` @ `7f6e855` (v1.9.0 plus the blueprint upload). **No app code was changed.** Everything below was read from the repo unless marked *(inferred)* or *(unverified)*. Numbers come from the repo, `gh`, and a local web build; nothing was measured on a phone.

Baseline health of the tree: `tsc --noEmit` clean, `oxlint` clean, `vitest` 161/161 passing.

## Verdict first: the byte bridge

**The current bridge is not safe for huge files, and it should be replaced with chunked native reads.**

- Every book is read as **one Base64 string** through a custom plugin method, `LibraryFolder.readFile` (`android/app/src/main/java/com/vach/reader/LibraryFolderPlugin.kt:303`). There is no `Filesystem.readFile` here, and `@capacitor/filesystem` is not a dependency.
- Native refuses anything over **150 MB** (`MAX_READABLE_FILE_BYTES`, `LibraryFolderPlugin.kt:30`, checked at line 327). So **a 400 MB PDF never reaches pdf.js. It fails immediately with "File is too large to open (over 150MB)".** The cap exists to avoid exactly the OOM the blueprint predicts.
- Files just under the cap still pay a large multiple of their size in memory (Q1 has the breakdown), so the cap is a floor on failure, not a guarantee of success.
- pdf.js is fed a **full `Uint8Array`**, not range requests (`src/lib/pdf.ts:563`).

---

## Findings

### Q1 — How bytes get from SAF into JS

**Exact path (EPUB and PDF both):**

1. `ReaderScreen.tsx:162-168` calls `readFileBase64(file.uri)` (`src/lib/libraryFolder.ts:220`).
2. That calls the Capacitor plugin `LibraryFolder.readFile({uri})`.
3. Native, `LibraryFolderPlugin.readFile` (`LibraryFolderPlugin.kt:303-355`):
   - validates the URI against persisted grants with `validateGrantedUri` (good, keep this);
   - rejects if `DocumentFile.length()` is over 150 MB (line 327);
   - `contentResolver.openInputStream(uri)?.use { it.readBytes() }` (line 333) reads **the whole file into one `ByteArray`**;
   - `Base64.encodeToString(bytes, NO_WRAP)` (line 347) makes **one Base64 `String`**;
   - `call.resolve(JSObject)` serialises it into the bridge message.
4. Bridge (`@capacitor/android` 8.5.2, `MessageHandler.sendResponseMessage`): the whole `data.toString()` is posted as **one message** (`javaScriptReplyProxy.postMessage(...)`, or `evaluateJavascript` on the legacy path). Large results are not chunked or streamed.
5. JS decodes it:
   - **PDF:** `pdf.ts:157` `base64ToBytes` does `atob()` (a full binary string), then copies it byte-by-byte into a `Uint8Array`; `pdf.ts:563` calls `pdfjsLib.getDocument({ data })`.
   - **EPUB:** `epub.ts:540` `JSZip.loadAsync(base64, { base64: true })`. JSZip decodes the whole thing and keeps it for the life of the generator.

**What happens to a 400 MB PDF:** it is rejected natively (above), so it cannot be opened at all today.

**What happens to a file just under the cap (e.g. 140 MB)** *(inferred, not measured)*. At peak, several copies exist at once:

| Where | Copy |
| :-- | :-- |
| Native | raw `ByteArray` (N) |
| Native | Base64 `String` (~1.33 N) |
| Native | `JSObject.toString()` for the message. Android's `org.json` also escapes `/` as `\/`, and Base64 contains many `/`, so slightly more than 1.33 N. |
| Renderer | received message string (~1.33 N+) |
| Renderer | `JSON.parse` result string (~1.33 N) |
| Renderer | `atob` binary string (N) |
| Renderer | `Uint8Array` (N) |
| Renderer/worker | pdf.js's own copy sent to its worker (N) *(unverified whether transferred or cloned)* |

That is roughly **6–8× the file size across native and renderer** at the high-water mark, and the native comment at `LibraryFolderPlugin.kt:23-29` makes the same argument for the 150 MB choice. This is the number to confirm with `dumpsys meminfo` (see the phone checklist).

**pdf.js: full buffer, no range requests.** `getDocument({ data })` only. No `PDFDataRangeTransport`, no `range` option, no URL. `streamChaptersImpl` (`pdf.ts:364-407`) then walks **every page in order** calling `getTextContent()`, so even with range loading the whole file would eventually be read (see Risks, R2).

**Threads:** all Capacitor plugin calls and Base64/ZIP work happen on the **main thread**. The only Web Worker in the app is pdf.js's own (`pdfWorkerEntry.ts`, loaded via `?worker&url`). There is no app-owned worker.

### Q2 — Library scanner

**Listing (native):** `scanFolder` (`LibraryFolderPlugin.kt:378`) → recursive `collectLibraryFiles` (`:420`) using `DocumentFile.listFiles()`. For each entry it reads `name`, `isDirectory`, `uri`, `length()` and returns `{name, uri, path, size}`. Each of those `DocumentFile` getters is a separate `ContentResolver` query on SAF providers *(inferred from how `TreeDocumentFile` works; unmeasured)*, so a big library scans slowly. Sources are scanned in parallel from JS (`Promise.all` in `scanAllSources`, `libraryFolder.ts:172`).

**Extension filter** is in **three** places, not one:
1. `SUPPORTED_EXTENSIONS = setOf("pdf", "epub")` (`LibraryFolderPlugin.kt:21`), used by `collectLibraryFiles` (`:431`) and `handleFilesPicked` (`:239`).
2. `EXTENSION_FORMATS` / `detectFormat` (`src/lib/libraryText.ts:1-20`), which drives the `.fmt-badge` in `LibraryScreen.tsx:59`.
3. `openBookStream` in `ReaderScreen.tsx:74-85`: `.pdf` → pdf, **everything else → `streamEpub`**. A `.docx` would silently be fed to the EPUB parser and fail with "Not a valid EPUB".

`pickFiles` uses `type = "*/*"` with extension filtering on the results (`:171-182`), so no MIME change is needed for `.docx`.

**Caching: none for scan results.** `LibraryScreen.loadLibrary` (`LibraryScreen.tsx:114-129`) calls `scanAllSources()` on every mount and shows a spinner. What *is* persisted (Capacitor `Preferences`, not IndexedDB): the source list (`library_sources`), sort mode, reader settings, per-book reading position, and a progress index. Nothing caches parsed book data. `idb` is not a dependency.

**Adding `.docx` takes (not done, this is Step 0):**
- `SUPPORTED_EXTENSIONS` += `"docx"` in the Kotlin plugin.
- `BookFormat` / `EXTENSION_FORMATS` += `docx` in `libraryText.ts`, plus its test.
- A `.fmt-badge.docx` rule (existing ones: `App.css:351-369`).
- A `docx` branch in `openBookStream` (and fix the "else = epub" fallthrough).
- The empty-state string `No .pdf or .epub files found…` (`LibraryScreen.tsx:323`) and README wording.

### Q3 — Reading position (`readerAnchor.ts` / `readingPosition.ts`)

**Stored value** (`src/lib/readerAnchor.ts:9`, `readingPosition.ts:15`): a **structural** anchor, not a pixel offset:

```
{ chapterIndex, blockIndex, blockFraction }   // + name, size, savedAt
```

- `chapterIndex` = index of the `<section class="chapter">` (EPUB spine item, or one PDF page).
- `blockIndex` = index into `flattenToLeafBlocks(chapterEl)`, i.e. leaf `p/h1-6/li/pre/blockquote/figure/img/table` elements, plus any `div.scroll-x` wrapper, flattened through generic containers.
- `blockFraction` = 0–1 within that block.
- Stored in `Preferences` under `reading_position:<djb2(name + NUL + size)>` (`bookKey`, `readingPosition.ts:47-59`), so it survives a re-added folder but two books with the same name and byte size would collide.
- Saved 500 ms after scrolling stops, on back, on app background, and on unmount (`ReaderScreen.tsx:394-427`, `:268-275`).

**Font-size change or rotation:**
- **Across sessions (reopen):** robust. The anchor is structural, so reflow does not matter. Restore waits for fonts, scrolls to the block, then re-verifies after two animation frames (`ReaderScreen.tsx:325-359`).
- **Live, within a session: nothing re-anchors.** `updateSettings` (`:472`) only sets state. There is **no effect that recomputes the anchor when `fontSize`/`lineHeight`/`fontFamily` change**, and **no `resize`, `orientationchange` or `ResizeObserver` handler anywhere** (grep-verified). The activity declares `configChanges` for orientation/screenSize, so rotation does not recreate the page and does not trigger a restore either.
- So the live position after a font-size change or rotation depends entirely on **Chrome's native scroll anchoring** *(inferred: `overflow-anchor` is never set, per the comment at `ReaderScreen.tsx:346-351`)*. Scroll anchoring is suppressed when the anchor node's or an ancestor's computed margin/padding/size changes, and `.reader-content p { margin: 0 0 1em }` and `.chapter { margin-bottom: 2em }` are `em`-based, so they change with font size. **I expect drift here; needs the phone.** Worse, the debounced scroll save will then persist the drifted position as the new anchor.
- **The restore cost:** `restoreTarget` requires the target chapter to be parsed, so reopening at chapter 900 of 1,000 decompresses and sanitizes chapters 1–900 first, sequentially (`:306-323`, "Restoring your place… Chapter N of M"). There is no cache. This is the main warm-reopen cost and the case Phase 1's `bookCache` would address.

### Q4 — Chapter mounting, images, sanitizer, threads

**Chapter mounting: all chapters, appended, never unmounted.**
- `streamEpub` (`epub.ts:539`) and PDF `streamChapters` yield one sanitized HTML string per chapter/page.
- `ReaderScreen` buffers the first 4 (`INITIAL_CHAPTER_BATCH`, `:53`), then appends the rest one at a time via `setBook(prev => ({...prev, chaptersHtml: [...prev.chaptersHtml, html]}))` (`:228`). When a position is being restored, every chapter is appended as it arrives (`:213`).
- Rendered as `book.chaptersHtml.map(html => <section key={i} className="chapter" dangerouslySetInnerHTML=…/>)` (`:637-639`). **All chapters stay in React state *and* in the DOM.**
- Observation *(from code, unmeasured)*: each append copies the array (O(n)) and re-renders the whole list, so loading n chapters is O(n²) React work. For T2 (~1,000+ chapters) this is a likely jank source before any DOM cost.
- No `content-visibility`, no `contain-intrinsic-size`, no windowing for EPUB (grep-verified). PDF is different: raster pages use a windowed `PdfPageLoader` with render/evict `IntersectionObserver`s (`pdfPageLoader.ts`), but their text-page siblings are still plain DOM.

**Images: `data:` URLs.**
- EPUB: `resolveImage` (`epub.ts:575-595`) decompresses the entry (cap 20 MB, `MAX_IMAGE_UNCOMPRESSED_BYTES`), builds `data:<mediaType>;base64,…` via `bytesToBase64`, and caches it in a `Map` for the book. The data URI is embedded **inside the chapter HTML string**.
- SVG `<image>` wrappers are converted to `<img>` first (`convertSvgImagesToImg`, `:402`).
- **No downscale, no `createImageBitmap`, no `blob:` URLs, no `URL.createObjectURL`, no `width/height/aspect-ratio` stamping** (the publisher's own `width`/`height` attrs survive; otherwise none). Each image is decoded at full resolution by the browser.
- PDF raster pages: `canvas.toDataURL('image/jpeg')` (`pdf.ts:523`), already size-capped (`MAX_PIXELS` 2.6 MP), with an `aspect-ratio` placeholder (`buildPagePlaceholder`, `pdf.ts:~330`) so no layout shift.

**Sanitizer: DOMPurify, main thread only.**
- `epub.ts:2` imports DOMPurify; `sanitizeChapterHtml` (`:487`) runs `new DOMParser()` then DOMPurify, `sanitizePlainFragment` (`:510`) / `sanitizePlainTextOnly` (`:528`) are also used by `pdf.ts`. A single global hook registered at module load (`:354-363`).
- `DOMParser` is also used in `findOpfPath`, `parseOpf`, `extractTitle` (`:142,161,191`).
- **Nothing touches the DOM from a Web Worker today**, because the app has no worker of its own. pdf.js's worker does not use the DOM. So the blueprint's thread rule is already satisfied; it just means every byte of ZIP/XML/HTML/sanitize work currently blocks the main thread (JSZip yields between chunks, but there is no off-thread work).
- Allowlist (`:221-274`) is already tight and has consequences for the plan:
  - `<a>`, `svg`, `class`, `id`, `data-*` are **not** allowed. Inline `style` is allowed but only for ~10 properties (`ALLOWED_STYLE_PROPS`), so publisher `white-space`, `width`, `background`, `color` in `style` are **already stripped**.
  - `width`/`height`/`colspan`/`rowspan` attributes **are** allowed, so rigid `<table width=…>`, `<td width=…>` and `<img width height>` do survive.
  - `<img src>` is accepted **only** if it starts with `data:image/` (hook at `:360`, plus `ALLOWED_URI_REGEXP: /^data:image\//i` at `:368`).

### Q5 — TOC and in-book search

- **Table of contents: none.** No `nav.xhtml`/`toc.ncx` parsing (`epub.ts` reads only `container.xml` and the OPF), no `getOutline()` in `pdf.ts`, no TOC component (grep-verified: no `toc`/`outline` anywhere in `src/`). The reader's only chapter UI is the restore overlay's "Chapter N of M".
- **In-book search: none.** The only search is the **library title filter** (`LibraryScreen.tsx`, debounced 120 ms, `libraryText.matchesQuery`).
- So blueprint Phase 5a applies (Step 0 found none).

### Q6 — `INTERNET` permission

- **Not declared.** `android/app/src/main/AndroidManifest.xml` has a comment explaining it was deliberately removed. There is no `src/debug` or `src/release` manifest overlay (only `src/debug/res/values/strings.xml`).
- **It is enforced by CI on the merged manifest,** for both debug (`android-build.yml`, "Verify no INTERNET permission in merged manifest", via `aapt2 dump permissions`) and release (`release.yml:235`, "Guard - no INTERNET permission in merged manifest"). `@capacitor/android`'s own library manifest is empty (checked in `node_modules`).
- **Nothing in the app depends on it.** `capacitor.config.ts` has no `server.url` (no live-reload), `CapacitorHttp.enabled: false`, and no `cleartext` setting. The Vite dev server is browser-only and unrelated to the APK. CSP is `connect-src 'self'` (`index.html:24`).
- **Blueprint item 2.1.6 is already done.** Nothing to remove; the only action is to keep the CI guard.
- Relevant to measuring: `chrome://inspect` works over `adb` USB without `INTERNET` (DevTools uses a local socket), but **WebView debugging is only on for debuggable builds** (`CapConfig.java:286,608`: defaults to `isDebug`/`FLAG_DEBUGGABLE`), and `release.yml:285` actually *fails* the release if the APK is debuggable. **Use the debug APK for inspection** (package `com.vach.reader.debug`).

### Q7 — Horizontal-scroll rules, table/image CSS, font stack

**Horizontal scroll / overflow** (`src/App.css`):
- `.reader-content { max-width: 640px; min-width: 0; overflow-x: hidden; … }` — `:638-648` (blueprint wants `overflow-x: clip`).
- `.reader-content .scroll-x { overflow-x: auto; max-width: 100%; }` — `:736-739`. This is the `.scroll-x` trap.
- `.scroll-x` is also hard-wired in code, so it cannot just be deleted from CSS:
  - `epub.ts:466` `wrapWideElements` wraps **every `<table>` and `<pre>`** in `<div class="scroll-x">` (shared with `pdf.ts` via `sanitizePlainFragment`).
  - `readerAnchor.ts:29-34` `isLeafBlock` treats `.scroll-x` as an atomic leaf, and `readerAnchor.test.ts` covers it.
- Other `overflow` rules are in library/UI components (`:253, :308, :399, :438, :502, :555, :587`), unrelated to the reader.

**Table CSS** (`:741-764`): `.reader-content table { border-collapse: collapse; font-size: 0.95em }`; `th, td { border: 1px solid rgba(128,128,128,0.35); padding: 6px 10px; text-align: left; vertical-align: top; overflow-wrap: anywhere }`; `th { background: rgba(128,128,128,0.12); font-weight: 700 }`. Neutral borders already match the blueprint's value. There is no `table-layout`, no compact/card/complex class, and no table code in JS beyond the wrapper.

**Text-wrap CSS:** `.reader-content p { overflow-wrap: anywhere }` (`:721-726`) and `td/th` (`:758`). **Not** set on links (none exist, `<a>` is forbidden) or `pre/code`; `pre` has no `white-space` rule (`:766-770`), so long lines scroll inside `.scroll-x` today.

**Image CSS:** `.reader-content img { max-width: 100%; height: auto; }` (`:716-719`). No `max-height`, no `object-fit`, no `display:block`/margin, no night filter for EPUB images. PDF page images: `.pdf-page`, `.pdf-page-img`, `mix-blend-mode: multiply` for sepia/beige, `filter: brightness(0.8)` on night (`:803-846`). No `svg` rule (SVG is stripped before mount).

**Font stack** (`src/lib/readerSettings.ts:75-81`):

| id | stack |
| :-- | :-- |
| serif | `Georgia, Cambria, "Times New Roman", Times, serif` |
| sans | `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` |
| literata | `"Literata", Georgia, serif` |
| merriweather | `"Merriweather", Georgia, serif` |
| atkinson | `"Atkinson Hyperlegible", system-ui, sans-serif` |

- **No Devanagari-capable family appears in any stack.** Devanagari currently relies entirely on whatever the ROM's generic `serif`/`sans-serif` fallback resolves to (Georgia/Cambria/Times are not normally installed on Android, so this most likely falls through to the system serif; *unverified on the phone*).
- Bundled fonts: Literata, Merriweather, Atkinson Hyperlegible via `@fontsource/*`, imported in `src/main.tsx:4-15` (400/700, normal+italic). None of the three ships a Devanagari subset.
- UI chrome also hard-codes `'Literata', Georgia, serif` (`App.css:55, 311, 380`), including the app title.

### Q8 — APK size

- **Latest release APK (v1.9.0), from `gh api repos/bhagatshivam/Vach/releases/latest`: `Vach.apk` = 6,103,562 bytes (≈ 5.82 MiB / 6.10 MB).** This is the signed release build and the number to use as "before" for Phase 4 onward.
- **Latest debug build artifacts** (`gh api …/actions/artifacts`): `vach-debug-apk` = 6,804,383 – 6,804,386 bytes across the five most recent runs. These are GitHub's artifact-zip sizes, not raw APK sizes (APKs are already compressed, so the difference is small, but treat as ±1%).
- **CI does not record APK size.** `release.yml:216-220` only does `ls -l` on the output dir (its log contains the size, but nothing writes it to a summary), and `android-build.yml` has no size step. The blueprint's "add a size line to the CI workflow output" is **not done yet** and will need a small workflow change in a later phase (not this one).
- `gh run list` shows a run still queued for the newest `main` commit when checked, so a fresh number for `7f6e855` was not available. It adds only a doc file, so the size should be unchanged.
- **Not built locally:** no Android SDK in this environment (`ANDROID_HOME` unset, no `aapt2`/`sdkmanager`).
- **What the web bundle looks like** (local `npm run build`, 119 files, 4.5 MB uncompressed; useful for where the APK's 6 MB comes from, not a substitute for the APK size):
  - `pdf.worker` 1.24 MB, `pdf` chunk 0.49 MB, main bundle 0.26 MB, `epub` chunk 0.13 MB.
  - Fonts: **53 `.woff2` (990 KB) and 56 `.woff` (1,241 KB) are both emitted**, i.e. every font ships twice. Android WebView supports woff2, so the `.woff` copies look like ~1.2 MB of dead weight *(inferred; would need a CSS/Vite change to drop and a phone check; out of scope for this session)*. This matters for the blueprint's "~1–1.5 MB font budget" in Phase 4.3.

---

## Differences from the blueprint's assumptions

| Blueprint says | Reality |
| :-- | :-- |
| "SAF plugin… `Filesystem.readFile`" (§2.1.1, §2.3) | Custom Kotlin plugin `LibraryFolderPlugin` (name `LibraryFolder`), registered in `MainActivity.java`. Methods: `pickFolder`, `pickFiles`, `scanFolder`, `statFile`, `readFile`, `hasPersistedPermission`. `readFile` is whole-file Base64 with a **150 MB hard cap**. Adding `readChunk`/`getSize` means extending this file. |
| File names `libraryFolder.ts`, `readerAnchor.ts`, `readerSettings.ts`, `ReaderScreen.tsx` | All exist. `ReaderScreen.tsx` is at `src/screens/ReaderScreen.tsx`. |
| IndexedDB via `idb` for `bookCache` | No IndexedDB or `idb` today. Persistence is `@capacitor/preferences` only. `idb` would be a new dependency. |
| `INTERNET` may be declared; remove it for release (§2.1.6) | Already absent from the manifest and **guarded in CI** on both builds. Nothing to do. |
| "Is there a TOC drawer / in-book search?" | Neither exists (library title filter only). Phase 5a applies. |
| Phase 4: strip publisher `nowrap`/fixed px/white backgrounds in the DOMPurify config | Mostly already done: `style` is limited to ~10 properties and `nowrap`/`bgcolor`/`class` aren't allowed attributes. What survives is `width`/`height` attributes on `table/td/th/img`, plus `colspan`/`rowspan`. |
| Phase 4: "remove the old `.scroll-x` rules" | `.scroll-x` is also created in `epub.ts` (`wrapWideElements`, also used by `pdf.ts`) **and** special-cased in `readerAnchor.ts` + its tests. Removing it changes which element is a leaf block, which **changes `blockIndex` for already-saved positions** (see R3). |
| Phase 4: `overflow-wrap: anywhere` on paragraphs and table cells | Already present on `p` and `th/td`. Missing on `pre/code`; `.reader-content` uses `overflow-x: hidden`, not `clip`. |
| Phase 4: add a Devanagari family "after the reading fonts in `readerSettings.ts`" | Stacks are in `FONT_FAMILY_OPTIONS` there, so that part holds. The UI/app-title font ("वाच" would go here) is hard-coded in `App.css`, not `readerSettings.ts`. |
| Phase 3A: serve images via `URL.createObjectURL` | **Blocked by the current security config.** The sanitizer hook and `ALLOWED_URI_REGEXP` only accept `data:image/`, and the CSP is `img-src 'self' data:` (`index.html:24`), so a `blob:` `<img>` would be dropped by DOMPurify *and* refused by the CSP. Phase 3A needs a deliberate, reviewed change to both (e.g. `img-src 'self' data: blob:` and the hook/regex). `worker-src 'self'` is fine for a bundled worker but would block blob-URL workers. |
| Phase 3A: "stamp width/height/aspect-ratio before mount" | `width`/`height` allowed attributes pass through; inline `aspect-ratio` would be stripped by the style allowlist unless added. The PDF placeholder is injected *after* sanitization, which is how it gets away with it today. |
| "Keep a reference to the original source (archive entry)" | Feasible: `streamEpub` already holds `manifestByHref` + the JSZip object, but those are closure-local to the generator, not reachable from the UI. Needs an API change. |
| Phase 1: "lazy chapter appending (no unmounting)" | **Chapters are already appended and never unmounted; the cost is that the whole list is re-rendered per append** (O(n²)), and restore needs every chapter up to the target parsed. `content-visibility` is absent. |
| Phase 1: parser worker "receives byte chunks, does ZIP decompression" | No app worker exists. EPUB parsing (`JSZip`, `DOMParser`, DOMPurify) is all main-thread. DOM-free parts (ZIP inflate, OPF text → via regex or a DOM-free parser) can move; `DOMParser` use in `epub.ts` (OPF, container.xml) would have to be replaced to run in a worker. |
| "Scroll anchoring still behaves with `readerAnchor`" | `readerAnchor` is purely structural and only recomputed on scroll; there is **no re-anchor on font/size/orientation change** (Q3). The blueprint's DoD ("readerAnchor regression check after font-size change and rotation") will currently fail or pass by luck of Chrome's scroll anchoring. |
| Release APK size line in CI | Not present (Q8). |

---

## Recommended fix for the byte bridge

**Replace whole-file Base64 with a native `readChunk` + `getSize`, then build the format readers on top.** Staged, so each step is independently testable on the phone:

**1. Native plugin (additive, keep `readFile` until nothing calls it).**
- `getSize({uri}) → {size}`.
- `readChunk({uri, offset, length}) → {base64}` for a **1–2 MiB** slice (start at 1 MiB, tune on the phone). Use `contentResolver.openFileDescriptor(uri, "r")` and a `FileChannel` positioned read (not `skip()` on a stream, which is O(offset) on some providers). Open the descriptor per call or cache one per URI on the plugin and close on release.
- **Reuse `validateGrantedUri` on every call.** It is a small, self-contained function and the right place for the security check.
- Clamp `length` natively (e.g. ≤ 4 MiB) and reject negative/overflowing `offset`. Return fewer bytes at EOF.
- Remove the 150 MB cap only for the chunked path.

**2. JS wrapper** in `libraryFolder.ts`: `getSize(uri)`, `readRange(uri, begin, end) → Uint8Array` (loops chunks, `atob` per chunk). All plugin calls stay on the main thread; transfer the resulting `ArrayBuffer` to a worker later.

**3. PDF: `PDFDataRangeTransport`.** Implement `requestDataRange(begin, end)` with `readRange` and answer via `onDataRange`, passed as `getDocument({ range: transport, length: size, disableAutoFetch: true })`. This removes the whole-file Base64/`atob` path and the multi-copy peak.
   - Caveat: pdf.js allocates a full-length buffer in its worker for range-loaded docs, and the current `streamChaptersImpl` reads every page. So this brings the peak down from ~6–8× to ~1× file size and allows first-text early, but it does **not** by itself make memory flat. See R2.

**4. EPUB / (later) DOCX: ZIP central-directory reads.**
   - Read the last ~64 KB (EOCD, then the central directory if larger), parse entries (name, compressed/uncompressed size, local-header offset, method), then for each requested entry read its local header (30 B + name + extra) and its compressed bytes, and inflate with `DecompressionStream('deflate-raw')` *(availability in the target WebView is unverified; fall back to fflate/pako or JSZip's bundled inflate)*.
   - **JSZip cannot load from ranges** (`loadAsync` wants the whole buffer), so this is a small custom reader, not a JSZip tweak.
   - **Interim, cheap win:** until that exists, have EPUB assemble the file from chunks into one `Uint8Array` and call `JSZip.loadAsync(uint8array)`. That removes the Base64 string, the `\/` blow-up and the `atob` copy for EPUBs (peak ≈ 1–2× file size) with almost no new code, and EPUBs are usually well under 100 MB.

**Keep as-is** if the owner's T6 and every other book are comfortably small *and* open reliably. The measurements below decide it: if T6 is under ~150 MB and opens with acceptable PSS on a real phone, the urgency drops, but the 150 MB wall and the 6–8× multiplier remain real limits.

**Not recommended now:** the `shouldInterceptRequest` HTTP-range alternative (blueprint §2.3). It needs 206 handling and a custom scheme, and its only advantage (workers can `fetch` it) isn't needed while plugin calls stay on the main thread.

---

## Risks

- **R1 — Acceptance wording for Step 0.** "T6 opens without memory spikes proportional to file size" is likely unachievable for PDFs with range loading alone (pdf.js worker buffer ≈ file size, and `streamChaptersImpl` extracts text for all pages). Suggest rewording to "peak PSS ≤ ~1.5× file size, and no Base64 whole-file string", or add lazy per-page extraction (Phase 1) before holding the line.
- **R2 — Sequential full-document text pass.** Even after the bridge fix, opening a PDF still parses every page in order, and restoring at page N means pages 1..N first. Range transport doesn't change that; a lazily-extracted page window would, but it changes the anchor/progress model for PDFs (`chapterIndex` = page).
- **R3 — Saved-position compatibility.** `blockIndex` is an index into `flattenToLeafBlocks`. Anything that changes leaf structure (removing/replacing the `.scroll-x` wrapper in Phase 4, wrapping images in figures in Phase 3A, table→card rewrites) will shift `blockIndex` for existing users' saved positions, landing them in the wrong paragraph with no error. Mitigate by keeping leaf detection stable (treat the new table container as the same kind of leaf) and adding regression tests with a saved anchor against the old and new DOM.
- **R4 — `blob:` images vs. security posture.** Phase 3A's blob-URL plan means loosening CSP `img-src` and the DOMPurify `src` hook, i.e. editing the app's main hardening points. Keep it as narrow as possible (`blob:` for `img-src` only; no `blob:` for scripts/workers) and add a sanitizer test that `javascript:`/`http:` `src` is still dropped.
- **R5 — Main-thread blocking.** All EPUB parse/sanitize work is main-thread; adding image downscaling or DOCX conversion there without a worker will worsen scroll jank on T2. The O(n²) append (Q4) should be measured before and after Phase 1.
- **R6 — Live re-anchoring is missing.** Phase 4's table re-measure-on-settings-change and the DoD "readerAnchor regression check after font size/rotation" both assume the position survives a live reflow. It currently relies on Chrome scroll anchoring, which I expect to be suppressed by `em`-based margins. Likely needs an explicit re-anchor (capture anchor before the change, restore after layout) in Phase 4.
- **R7 — SAF scan performance.** Per-entry `DocumentFile` queries can make big folders slow, and the scan reruns on every library mount with no cache. Not a blocker for the upgrade, but a candidate for the cache work.
- **R8 — Release builds can't be inspected.** `release.yml` requires a non-debuggable APK, so the owner's `chrome://inspect` measurements must use the debug APK (`com.vach.reader.debug`). Debug builds are unminified and slightly slower, so timings are an upper bound on release performance. (The release build also has `minifyEnabled false`.)
- **R9 — Duplicate font formats.** Shipping both `.woff` and `.woff2` costs ~1.2 MB of the ~6 MB APK *(inferred)*. Adding Devanagari fonts on top of that would blow the blueprint's 1–1.5 MB budget unless this is trimmed first. Worth a size check in Phase 4.
- **R10 — Could not verify.** Anything marked *(inferred)* or *(unverified)* above, all phone measurements, and the real size of the current build artifacts on `main` @ `7f6e855`.

---

## Phone measurements for the owner

Fill in the empty cells. Use the **debug** build from the GitHub Actions `vach-debug-apk` artifact so WebView inspection is available. Package name: `com.vach.reader.debug`. Use the same phone and the same build for every run, and note the phone model and Android version in the first table.

| Device | Android version | Build / commit | Date |
| :-- | :-- | :-- | :-- |
| | | | |

**Setup.** Enable USB debugging, connect via USB, then:

```bash
adb devices
adb shell pidof com.vach.reader.debug
```

Open `chrome://inspect/#devices` on a desktop Chrome and click **inspect** under the Vach WebView (needed for the Performance panel). Force-stop and clear nothing between "cold" runs except as described.

**How to time "first visible text".** Tap the book and start a stopwatch (or a 60 fps screen recording and count frames). Stop when the first line of book text is readable (not the "Opening book…"/"Parsing…" status and not the restore overlay).

- **Cold open:** `adb shell am force-stop com.vach.reader.debug`, relaunch the app, tap the book.
- **Warm reopen:** with the app still running, press Back to the library, tap the same book again. Do this once with a saved position far into the book (e.g. 90%) and once at the start.

### A. Open time to first visible text (seconds)

| Book | Cold, no saved position | Cold, saved position ≈ 90% ("Restoring…" time) | Warm reopen, saved position ≈ 90% | Notes (spinner, jank, errors) |
| :-- | :-- | :-- | :-- | :-- |
| T1 — 246-page light novel PDF | | | | |
| T2 — ~1,000-chapter EPUB | | | | |
| T6 — largest PDF in the library | | | | |

### B. Peak memory (PSS)

Run this in a second terminal and note the `TOTAL PSS` line (and the `Native Heap`, `Java Heap`, `Graphics` rows):

```bash
adb shell dumpsys meminfo com.vach.reader.debug
```

Take readings at: **(1)** app idle on the library, **(2)** the moment text first appears, **(3)** the peak while the book is still loading, and **(4)** after 5 minutes of scrolling. To catch the peak, repeat the command every ~2 s while the book opens (a loop such as `while true; do adb shell dumpsys meminfo com.vach.reader.debug | grep -E "TOTAL PSS|Native Heap|Java Heap"; sleep 2; done`).

| Book | File size (MB) | (1) Library idle PSS (MB) | (2) First text PSS (MB) | (3) Peak while opening PSS (MB) | (4) After 5 min scrolling PSS (MB) |
| :-- | :-- | :-- | :-- | :-- | :-- |
| T1 | | | | | |
| T2 | | | | | |
| T6 | | | | | |

Also note any crash, "Failed to open book.", blank screen, or WebView reload, and check `adb logcat -d | grep -i -E "OutOfMemory|lowmemory|chromium.*oom|Process .* died"` right after.

### C. Scroll smoothness on T2 (~1,000-chapter EPUB)

Scroll the same stretch (e.g. chapters ~1–50, then jump to chapter ~500, then ~900) at normal reading speed and at a hard fling. Choose one measurement:

- **Quick:** `adb shell dumpsys gfxinfo com.vach.reader.debug reset`, do the scroll, then `adb shell dumpsys gfxinfo com.vach.reader.debug` and note **Total frames rendered**, **Janky frames** (and %), and the **90th/95th/99th percentile frame times**.
- **Detailed:** in the inspect window, Performance panel → record the scroll → note long tasks over 50 ms and any dropped-frame regions.

| Phase of use | Janky frames % | 95th pct frame time (ms) | Long tasks > 50 ms (count) | Felt smooth? (y/n) |
| :-- | :-- | :-- | :-- | :-- |
| While the book is still streaming in (first ~60 s after open) | | | | |
| Fully loaded, normal scroll | | | | |
| Fully loaded, hard fling | | | | |
| Right after changing font size once | | | | |

### D. Does the largest PDF (T6) open at all?

| Question | Result |
| :-- | :-- |
| Exact file name and size (MB) | |
| Opens? (yes / no) | |
| If no: exact error text on screen (e.g. "File is too large to open (over 150MB)") | |
| If yes: time to first text (s), peak PSS (MB) from B | |
| Does it finish loading all pages? How long? | |
| Does reopening at a saved position far in the file work? | |

### E. Position after a live font-size change and rotation (checks R6)

On T2 and on a table-heavy EPUB (T3), scroll to a recognisable paragraph in the middle of a chapter, then:

| Action | Paragraph still on screen? (same / shifted by about N paragraphs / far away) |
| :-- | :-- |
| T2: increase font size by 4 steps | |
| T2: decrease font size back | |
| T2: rotate to landscape | |
| T2: rotate back to portrait | |
| T2: change line height | |
| T3: increase font size by 4 steps | |
| T3: rotate to landscape | |
| Close and reopen after the above: lands on the paragraph shown at close? | |

### F. Housekeeping

| Item | Result |
| :-- | :-- |
| Does `chrome://inspect` show the debug WebView? | |
| Any file in the library that fails to open at all (name, error text) | |
| Release APK size from the latest GitHub Release (bytes, from the asset page) | 6,103,562 (v1.9.0, from `gh`) |
