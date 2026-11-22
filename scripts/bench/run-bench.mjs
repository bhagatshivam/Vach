#!/usr/bin/env node
// Orchestrates the Phase 1b sandbox benchmarks. See scripts/bench/README.md.
//
//   node scripts/bench/run-bench.mjs [--fixtures <dir>] [--reps 3] [--only restore,small,threshold,scale,render]
//                                    [--before-ref origin/main] [--out <results.json>] [--big]
//                                    [--threshold-fixtures a,b,c]
//
// "before" = the code at --before-ref (default origin/main, i.e. without Phase
// 1b), built from a temporary git worktree. "after" = this working tree.
// Every measurement runs in a fresh Node process (so peak RSS is per run) with
// jsdom preloaded; all timings are Node/jsdom timings, not phone timings.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const fixturesDir = resolve(flag('fixtures', join(tmpdir(), 'vach-bench')));
const reps = Number(flag('reps', '3'));
const beforeRef = flag('before-ref', 'origin/main');
const only = new Set(flag('only', 'restore,small,threshold,scale,render').split(','));
const outFile = resolve(flag('out', join(fixturesDir, 'results.json')));
const withBig = args.includes('--big');

const log = (...m) => console.error('[bench]', ...m);
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });

// ---------------------------------------------------------------------------
// Setup: fixtures, the "before" worktree, and the bundles
// ---------------------------------------------------------------------------

if (!existsSync(join(fixturesDir, 'fixtures.json')) || (withBig && !existsSync(join(fixturesDir, 'epub-d100.epub')))) {
  log('generating fixtures in', fixturesDir);
  sh('node', [join(here, 'gen-fixtures.mjs'), '--out', fixturesDir, ...(withBig ? ['--big'] : [])], { stdio: ['ignore', 'inherit', 'inherit'] });
}
const fixtures = JSON.parse(readFileSync(join(fixturesDir, 'fixtures.json'), 'utf8'));

const cache = join(repo, 'node_modules/.cache/vach-bench');
mkdirSync(cache, { recursive: true });
const beforeTree = join(tmpdir(), `vach-bench-before-${process.pid}`);

function setupBeforeTree() {
  log(`checking out ${beforeRef} into a temporary worktree`);
  sh('git', ['-C', repo, 'worktree', 'add', '--detach', beforeTree, beforeRef]);
  cpSync(here, join(beforeTree, 'scripts/bench'), { recursive: true });
  symlinkSync(join(repo, 'node_modules'), join(beforeTree, 'node_modules'));
}
function cleanupBeforeTree() {
  try {
    sh('git', ['-C', repo, 'worktree', 'remove', '--force', beforeTree]);
  } catch {
    rmSync(beforeTree, { recursive: true, force: true });
    sh('git', ['-C', repo, 'worktree', 'prune']);
  }
}
const build = (tree, entry, outDir) => sh('node', [join(here, 'build.mjs'), tree, entry, outDir]);

const bundles = {
  before: join(cache, 'before/entry-before.mjs'),
  after: join(cache, 'after/entry-after.mjs'),
  render: join(cache, 'render/entry-render.mjs'),
};

// ---------------------------------------------------------------------------
// Running and aggregating
// ---------------------------------------------------------------------------

function runOnce(bundle, scenarioArgs) {
  const result = spawnSync(
    'node',
    ['--expose-gc', '--import', join(here, 'dom-preload.mjs'), bundle, ...scenarioArgs],
    { encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  const line = (result.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`no RESULT from ${bundle} ${scenarioArgs.join(' ')}\n${result.stderr?.slice(-1500)}`);
  return JSON.parse(line.slice(7));
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};
const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

/** Runs the given variants `n` times, interleaved (so drift hits all of them alike), returns per-variant medians. */
function measure(variants, n) {
  const runs = Object.fromEntries(Object.keys(variants).map((k) => [k, []]));
  for (let i = 0; i < n; i++) {
    for (const [name, { bundle, scenario }] of Object.entries(variants)) runs[name].push(runOnce(bundle, scenario));
  }
  const out = {};
  for (const [name, list] of Object.entries(runs)) {
    out[name] = { raw: list };
    for (const key of Object.keys(list[0])) {
      if (typeof list[0][key] === 'number' || list[0][key] === null) out[name][key] = r1(median(list.map((r) => r[key])));
      else out[name][key] = list[0][key];
    }
  }
  return out;
}

const scen = (fixture, extra) => ['--fixture', fixture.path, ...extra];
const results = { generatedAt: new Date().toISOString(), node: process.version, reps, beforeRef, fixtures: Object.fromEntries(Object.entries(fixtures).map(([k, v]) => [k, { bytes: v.bytes, chapters: v.chapters }])) };

const fmt = (x, suffix = '') => (x === null || x === undefined ? 'n/a' : `${x}${suffix}`);
const table = (headers, rows) =>
  [`| ${headers.join(' | ')} |`, `| ${headers.map((_, i) => (i === 0 ? ':--' : '--:')).join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const ratio = (before, after) => (before && after ? `${(before / after).toFixed(1)}x` : 'n/a');

const markdown = [];
const section = (title, body) => {
  markdown.push(`### ${title}\n\n${body}\n`);
  console.log(`\n### ${title}\n\n${body}\n`);
};

let beforeReady = false;
try {
  if (only.has('restore') || only.has('small') || only.has('scale')) {
    setupBeforeTree();
    beforeReady = true;
    build(beforeTree, 'entry-before', join(cache, 'before'));
  }
  build(repo, 'entry-after', join(cache, 'after'));
  if (only.has('render')) build(repo, 'entry-render', join(cache, 'render'));
} catch (error) {
  if (beforeReady) cleanupBeforeTree();
  throw error;
}
process.on('exit', () => {
  if (beforeReady) cleanupBeforeTree();
});

// ---------------------------------------------------------------------------
// 1. Restore: open + time to the saved chapter + memory
// ---------------------------------------------------------------------------

function benchRestore(name, fixture, indexes, latency) {
  const rows = [];
  results[`restore-${name}`] = {};
  for (const index of indexes) {
    log(`restore ${name} @ chapter ${index}, ${latency} ms/call`);
    const common = ['--latency', String(latency), '--index', String(index), '--until', 'target'];
    const m = measure(
      {
        before: { bundle: bundles.before, scenario: scen(fixture, common) },
        after: { bundle: bundles.after, scenario: scen(fixture, common) },
      },
      reps,
    );
    results[`restore-${name}`][index] = m;
    const b = m.before;
    const a = m.after;
    rows.push([`chapter ${index}`, fmt(b.openMs, ' ms'), fmt(a.openMs, ' ms'), fmt(b.targetMs, ' ms'), fmt(a.targetMs, ' ms'), ratio(b.targetMs, a.targetMs), `${b.chaptersParsed} / ${a.chaptersParsed}`, `${fmt(b.peakRssDeltaMiB)} / ${fmt(a.peakRssDeltaMiB)}`, `${fmt(b.sampledPeakHeapDeltaMiB)} / ${fmt(a.sampledPeakHeapDeltaMiB)}`, `${fmt(r1(b.retainedHeapDeltaMiB + b.retainedBuffersDeltaMiB))} / ${fmt(r1(a.retainedHeapDeltaMiB + a.retainedBuffersDeltaMiB))}`]);
  }
  section(
    `Restore, ${name.toUpperCase()} (${(fixture.bytes / 1048576).toFixed(1)} MiB, ${fixture.chapters} chapters, ${latency} ms per bridge call; median of ${reps})`,
    table(['Restore at', 'Open before', 'Open after', 'Target ready before', 'Target ready after', 'Speed-up', 'Chapters parsed (before / after)', 'Peak RSS +MiB (b / a)', 'Peak JS heap +MiB (b / a)', 'Retained MiB (b / a)'], rows),
  );
}

if (only.has('restore')) {
  benchRestore('a', fixtures.a, [1, 500, 1450], 3);
  benchRestore('b', fixtures.b, [1, 150, 290], 3);
  benchRestore('a', fixtures.a, [1, 500, 1450], 0);
}

// ---------------------------------------------------------------------------
// 2. Small book regression
// ---------------------------------------------------------------------------

if (only.has('small')) {
  const rows = [];
  results.small = {};
  for (const latency of [0, 3]) {
    log(`small book C, ${latency} ms/call`);
    // first4 = the reader's first reveal (it buffers 4 chapters); all = every chapter loaded
    const first4 = ['--latency', String(latency), '--index', '0', '--until', 'first4'];
    const all = ['--latency', String(latency), '--index', '0', '--until', 'all'];
    const m1 = measure({ before: { bundle: bundles.before, scenario: scen(fixtures.c, first4) }, after: { bundle: bundles.after, scenario: scen(fixtures.c, first4) } }, Math.max(reps, 7));
    const m2 = measure({ before: { bundle: bundles.before, scenario: scen(fixtures.c, all) }, after: { bundle: bundles.after, scenario: scen(fixtures.c, all) } }, Math.max(reps, 7));
    results.small[latency] = { first4: m1, all: m2 };
    rows.push([`${latency} ms`, 'open', fmt(m1.before.openMs, ' ms'), fmt(m1.after.openMs, ' ms'), ratio(m1.before.openMs, m1.after.openMs)]);
    rows.push([`${latency} ms`, 'first 4 chapters', fmt(m1.before.first4Ms, ' ms'), fmt(m1.after.first4Ms, ' ms'), ratio(m1.before.first4Ms, m1.after.first4Ms)]);
    rows.push([`${latency} ms`, 'all 50 chapters', fmt(m2.before.allMs, ' ms'), fmt(m2.after.allMs, ' ms'), ratio(m2.before.allMs, m2.after.allMs)]);
    rows.push([`${latency} ms`, 'bridge calls (size + reads)', `${m2.before.sizeCalls} + ${m2.before.readCalls}`, `${m2.after.sizeCalls} + ${m2.after.readCalls}`, '']);
  }
  section(`Small-book regression, C (${(fixtures.c.bytes / 1048576).toFixed(2)} MiB, 50 chapters; median of ${Math.max(reps, 7)})`, table(['Bridge latency', 'Milestone', 'Before', 'After', 'Before / after'], rows));
}

// ---------------------------------------------------------------------------
// 3. Threshold study: whole-file (readAll + JSZip) vs ranged reads
// ---------------------------------------------------------------------------

if (only.has('threshold')) {
  results.threshold = {};
  const rows = [];
  const wanted = new Set(flag('threshold-fixtures', 'a,b').split(','));
  const study = [
    ['a', fixtures.a, 500],
    ['b', fixtures.b, 150],
    ['c', fixtures.c, 25],
  ].filter(([name]) => wanted.has(name));
  for (const [name, fixture, mid] of study) {
    for (const latency of [0, 1, 3, 10]) {
      log(`threshold ${name}, ${latency} ms/call`);
      const lat = ['--latency', String(latency)];
      const variants = (extra) => ({
        whole: { bundle: bundles.after, scenario: scen(fixture, [...lat, '--path', 'whole', ...extra]) },
        ranged: { bundle: bundles.after, scenario: scen(fixture, [...lat, '--path', 'ranged', ...extra]) },
      });
      const full = measure(variants(['--index', '0', '--until', 'all']), reps);
      const restore = measure(variants(['--index', String(mid), '--until', 'target']), reps);
      results.threshold[`${name}-${latency}`] = { full, restore };
      const win = (w, r) => (w === null || r === null ? 'n/a' : Math.abs(w - r) / Math.max(w, r) < 0.05 ? 'tie' : w < r ? 'whole' : 'ranged');
      rows.push([
        name.toUpperCase(),
        `${latency} ms`,
        `${fmt(full.whole.openMs)} / ${fmt(full.ranged.openMs)}`,
        win(full.whole.openMs, full.ranged.openMs),
        `${fmt(full.whole.first4Ms)} / ${fmt(full.ranged.first4Ms)}`,
        win(full.whole.first4Ms, full.ranged.first4Ms),
        `${fmt(restore.whole.targetMs)} / ${fmt(restore.ranged.targetMs)}`,
        win(restore.whole.targetMs, restore.ranged.targetMs),
        `${fmt(full.whole.allMs)} / ${fmt(full.ranged.allMs)}`,
        win(full.whole.allMs, full.ranged.allMs),
        `${full.whole.readCalls} / ${full.ranged.readCalls}`,
        `${fmt(full.whole.peakRssDeltaMiB)} / ${fmt(full.ranged.peakRssDeltaMiB)}`,
      ]);
    }
  }
  section(
    `Threshold study: whole-file (readAll + JSZip) / ranged (central directory), ms, median of ${reps}`,
    table(['Book', 'Latency/call', 'Open (w / r)', 'Win', 'First 4 chapters (w / r)', 'Win', 'Restore mid-book (w / r)', 'Win', 'All chapters (w / r)', 'Win', 'Bridge calls, full (w / r)', 'Peak RSS +MiB, full (w / r)'], rows),
  );
}

// ---------------------------------------------------------------------------
// 4. Scale: 100 MiB and 300 MiB
// ---------------------------------------------------------------------------

if (only.has('scale') && fixtures.d100) {
  results.scale = {};
  const rows = [];
  const cases = [
    ['D100 (98 MiB)', fixtures.d100, [0, 300, 595], false],
    ...(fixtures.d300 ? [['D300 (290 MiB, past the 150 MiB ceiling: direct ranged reader)', fixtures.d300, [0, 750, 1495], true]] : []),
  ];
  for (const [label, fixture, indexes, direct] of cases) {
    for (const index of indexes) {
      log(`scale ${label} @ ${index}`);
      const common = ['--latency', '3', '--index', String(index), '--until', 'target'];
      const variants = { after: { bundle: bundles.after, scenario: scen(fixture, [...common, ...(direct ? ['--direct'] : [])]) } };
      if (!direct) variants.before = { bundle: bundles.before, scenario: scen(fixture, common) };
      const m = measure(variants, 2);
      results.scale[`${label}-${index}`] = m;
      for (const [flow, v] of Object.entries(m)) {
        rows.push([label, `chapter ${index}`, flow, fmt(v.openMs, ' ms'), fmt(v.targetMs, ' ms'), String(v.readCalls), fmt(v.bytesTransferredMiB), fmt(v.peakRssDeltaMiB), fmt(r1(v.retainedHeapDeltaMiB + v.retainedBuffersDeltaMiB))]);
      }
    }
  }
  section('Scale (3 ms per bridge call; median of 2)', table(['Book', 'Restore at', 'Flow', 'Open', 'Target ready', 'Bridge calls', 'MiB transferred', 'Peak RSS +MiB', 'Retained MiB'], rows));
}

// ---------------------------------------------------------------------------
// 5. Chapter list render counts
// ---------------------------------------------------------------------------

if (only.has('render')) {
  log('render counts');
  const { render } = runOnce(bundles.render, []);
  results.render = render;
  section(
    'Chapter section renders while chapters are appended (before = modeled unmemoized list, after = ChapterList)',
    table(
      ['Chapters', 'List', 'Chapters per commit', 'Commits', 'Section renders', 'Total ms (jsdom)'],
      render.map((r) => [String(r.appends), r.kind, String(r.batch), String(r.commits), r.sectionRenders.toLocaleString('en-US'), String(r.totalMs)]),
    ),
  );
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(results, null, 2));
writeFileSync(outFile.replace(/\.json$/, '.md'), markdown.join('\n'));
log('wrote', outFile, 'and', outFile.replace(/\.json$/, '.md'));
