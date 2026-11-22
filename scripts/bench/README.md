# Phase 1b sandbox benchmarks

Synthetic-book benchmarks for the lazy EPUB opening work (PR "Phase 1b"). Nothing here ships in the app, and **generated books are never committed**: they are written to a temp directory.

## Read this first: what these numbers are (and are not)

- They run in **Node with jsdom**, not on a phone. Absolute timings are inflated (jsdom's DOM and DOMPurify are much slower than a browser's) and the "native bridge" is a fake in-memory file with a fixed sleep per call. Only the **before / after ratios** carry meaning.
- Memory is Node process RSS (the kernel's own peak counter, `VmHWM`) and V8 heap. A phone's WebView accounts memory differently.
- **Not measured here:** scroll smoothness while earlier chapters are prepended, real WebView behavior (see `chromium-check.mjs` for a desktop-Chromium approximation), and real native-bridge latency (the per-call latency is a parameter, 0 to 10 ms).

## Requirements

Node 22 and the repo's `npm ci`. Linux (memory probes read `/proc`). Git (the "before" code is checked out into a temporary worktree). `chromium-check.mjs` additionally needs Playwright with a Chromium.

## Run

```bash
# 1. Deterministic fixtures: EPUB-A (1,500 chapters, ~4 MiB, text), EPUB-B (300 chapters
#    with images, ~29 MiB), EPUB-C (50 chapters, small). Add --big for the optional
#    ~98 MiB and ~290 MiB books. Same arguments => byte-identical files.
node scripts/bench/gen-fixtures.mjs --out /tmp/vach-bench --big

# 2. Everything (about 20-30 minutes with --big; drop --big and 'scale' for ~15):
node scripts/bench/run-bench.mjs --fixtures /tmp/vach-bench --big --reps 3

# Just one part:
node scripts/bench/run-bench.mjs --fixtures /tmp/vach-bench --only restore
node scripts/bench/run-bench.mjs --fixtures /tmp/vach-bench --only small --reps 7
node scripts/bench/run-bench.mjs --fixtures /tmp/vach-bench --only threshold
node scripts/bench/run-bench.mjs --fixtures /tmp/vach-bench --only render

# 3. DecompressionStream, the central-directory reader and Unicode names in headless Chromium:
node scripts/bench/chromium-check.mjs --fixtures /tmp/vach-bench
```

Results are printed as Markdown tables and written to `results.json` / `results.md` (next to the fixtures unless `--out` is given).

`--before-ref <git ref>` chooses what "before" means (default `origin/main`, i.e. without Phase 1b). Run it on a quiet machine: each measurement is a fresh Node process, and the before/after runs are interleaved so drift affects both alike.

## What is in here

| File | Purpose |
| :-- | :-- |
| `gen-fixtures.mjs` | Seeded, deterministic EPUB generator. |
| `run-bench.mjs` | Orchestrator: builds both bundles, spawns one Node process per measurement, aggregates medians, prints tables. |
| `build.mjs` | Bundles a TypeScript entry into one ESM file (via Vite SSR build) so plain `node` can run it. |
| `dom-preload.mjs` | `node --import` preload that gives Node a jsdom `window`/`document`/`DOMParser`. |
| `harness.ts` | Fake file bridge with per-call latency, memory probes, argument parsing. |
| `entry-before.ts` | The pre-Phase-1b flow: `readAll` + whole-archive JSZip, parse chapters from 0. Built from the "before" worktree. |
| `entry-after.ts` | The Phase 1b flow: `openEpubFile` (whole-file or ranged by threshold), stream from the restore window. |
| `entry-render.tsx` | Chapter-section render counts while chapters are appended (uses the real render probe; the old list is modeled). |
| `browser-entry.ts`, `chromium-check.mjs` | The in-browser checks and their Playwright driver. |

## How each measurement is defined

- **Open**: bridge calls + archive opened + OPF/spine parsed (the book is ready to hand out chapters).
- **Target ready**: open, plus every chapter that has to be parsed before the saved chapter is on screen. Before Phase 1b that is chapters `0..N`; after it, chapters `N-1..N`.
- **First 4 chapters**: what the reader waits for when opening a book with no saved position (it buffers 4 chapters before revealing).
- **Peak RSS / JS heap (+MiB)**: growth over the process's own baseline (taken after the fixture file is in memory, so the fake "file" is not counted). RSS peak is the kernel's `VmHWM`, reset just before the measurement. JS heap peak is sampled per chapter, so it can miss short spikes.
- **Retained MiB**: heap + ArrayBuffers still held after a full GC while the book is open.
- **Chapter section renders**: before Phase 1b the list was a plain `.map()` inside the reader, so every append re-ran every section; it has no probe, so it is modeled by an unmemoized component that reports to the same probe. After: the real `ChapterList`.
