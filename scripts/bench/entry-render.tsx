/* oxlint-disable react/only-export-components -- a script entry, not a hot-reloaded module */
// Render counts and commit cost while chapters are appended, for the chapter
// list before Phase 1b (modeled) and after it (the real ChapterList).
//
// "Before" was a plain .map() of <section> elements inside ReaderScreen, so
// every append re-ran all existing sections. That has no probe in the old
// code, so it is modeled here by an unmemoized component per section that
// reports to the same probe - one count = one chapter section re-processed.
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ChapterList } from '../../src/components/ChapterList';
import { chapterRenderProbe } from '../../src/lib/chapterRenderProbe';
import { now, report, round } from './harness';

function LegacySection({ index, html }: { index: number; html: string }) {
  chapterRenderProbe.onRender?.(index);
  return createElement('section', { className: 'chapter', dangerouslySetInnerHTML: { __html: html } });
}

function LegacyList({ chaptersHtml }: { chaptersHtml: string[] }) {
  return createElement(
    'div',
    null,
    chaptersHtml.map((html, i) => createElement(LegacySection, { key: i, index: i, html })),
  );
}

// ~5 KB of paragraph markup per chapter, like a real webnovel chapter.
function chapterHtml(i: number): string {
  const paragraph = `<p>Chapter ${i}: ${'The quick brown fox jumps over the lazy dog. '.repeat(14)}</p>`;
  return paragraph.repeat(8);
}

function run(kind: 'before' | 'after', appends: number, batch: number) {
  document.getElementById('root')!.innerHTML = '';
  const root = createRoot(document.getElementById('root')!);
  let renders = 0;
  chapterRenderProbe.onRender = () => renders++;

  const chapters: string[] = [];
  let commits = 0;
  const t0 = now();
  for (let n = 0; n < appends; n += batch) {
    for (let k = 0; k < batch && n + k < appends; k++) chapters.push(chapterHtml(n + k));
    const snapshot = chapters.slice();
    flushSync(() =>
      root.render(
        kind === 'before'
          ? createElement(LegacyList, { chaptersHtml: snapshot })
          : createElement(ChapterList, { firstChapterIndex: 0, chaptersHtml: snapshot }),
      ),
    );
    commits++;
  }
  const totalMs = now() - t0;
  root.unmount();
  chapterRenderProbe.onRender = null;
  return { kind, appends, batch, commits, sectionRenders: renders, totalMs: round(totalMs), msPerCommit: round(totalMs / commits, 2) };
}

const results = [];
for (const appends of [60, 300, 600]) {
  results.push(run('before', appends, 1));
  results.push(run('after', appends, 1));
  results.push(run('after', appends, 10)); // one commit per 10 chapters, like the reader's batched flush
}
report({ render: results });
