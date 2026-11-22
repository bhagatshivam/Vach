import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChapterList } from './ChapterList';
import { chapterRenderProbe } from '../lib/chapterRenderProbe';

afterEach(() => {
  cleanup();
  chapterRenderProbe.onRender = null;
});

function chapters(from: number, to: number): string[] {
  return Array.from({ length: to - from }, (_, i) => `<p>chapter ${from + i}</p>`);
}

function trackRenders() {
  const counts = new Map<number, number>();
  chapterRenderProbe.onRender = (index) => counts.set(index, (counts.get(index) ?? 0) + 1);
  return counts;
}

describe('ChapterList - appends do not re-render existing chapters', () => {
  it('renders each chapter exactly once while 50 chapters are appended one at a time', () => {
    const counts = trackRenders();
    const { rerender } = render(<ChapterList firstChapterIndex={0} chaptersHtml={chapters(0, 1)} />);
    for (let n = 2; n <= 50; n++) {
      rerender(<ChapterList firstChapterIndex={0} chaptersHtml={chapters(0, n)} />);
    }
    expect(counts.size).toBe(50);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
    // Total renders is linear in chapters, not quadratic (which would be 1275).
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(50);
  });

  it('batch appends (several chapters per update) also render each chapter once', () => {
    const counts = trackRenders();
    const { rerender } = render(<ChapterList firstChapterIndex={0} chaptersHtml={chapters(0, 4)} />);
    rerender(<ChapterList firstChapterIndex={0} chaptersHtml={chapters(0, 9)} />);
    rerender(<ChapterList firstChapterIndex={0} chaptersHtml={chapters(0, 20)} />);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
    expect(counts.size).toBe(20);
  });

  it('keeps the existing chapters\' DOM nodes (same elements, untouched) across appends', () => {
    const { container, rerender } = render(<ChapterList firstChapterIndex={0} chaptersHtml={chapters(0, 3)} />);
    const before = Array.from(container.querySelectorAll('section.chapter'));
    // Something the reader's DOM code could have done to a mounted chapter (a highlight, a measured style).
    before[0].setAttribute('data-touched', 'yes');

    rerender(<ChapterList firstChapterIndex={0} chaptersHtml={chapters(0, 8)} />);

    const after = Array.from(container.querySelectorAll('section.chapter'));
    expect(after).toHaveLength(8);
    expect(after.slice(0, 3)).toEqual(before); // identical element objects
    expect(after[0].getAttribute('data-touched')).toBe('yes');
  });

  it('prepending earlier chapters also leaves the mounted ones alone (keys are book indexes)', () => {
    const counts = trackRenders();
    const { container, rerender } = render(<ChapterList firstChapterIndex={7} chaptersHtml={chapters(7, 10)} />);
    const before = Array.from(container.querySelectorAll('section.chapter'));

    rerender(<ChapterList firstChapterIndex={6} chaptersHtml={chapters(6, 10)} />);
    rerender(<ChapterList firstChapterIndex={5} chaptersHtml={chapters(5, 10)} />);

    const after = Array.from(container.querySelectorAll('section.chapter'));
    expect(after).toHaveLength(5);
    expect(after.slice(2)).toEqual(before); // chapters 7, 8, 9 are the very same elements
    expect([...counts.entries()].sort()).toEqual([
      [5, 1],
      [6, 1],
      [7, 1],
      [8, 1],
      [9, 1],
    ]);
    expect(after.map((el) => el.textContent)).toEqual(['chapter 5', 'chapter 6', 'chapter 7', 'chapter 8', 'chapter 9']);
  });

  it('does re-render a chapter whose HTML actually changed', () => {
    const counts = trackRenders();
    const { rerender } = render(<ChapterList firstChapterIndex={0} chaptersHtml={['<p>a</p>', '<p>b</p>']} />);
    rerender(<ChapterList firstChapterIndex={0} chaptersHtml={['<p>a</p>', '<p>B changed</p>']} />);
    expect(counts.get(0)).toBe(1);
    expect(counts.get(1)).toBe(2);
  });

  it('renders the sanitized HTML inside plain <section class="chapter"> children of the container', () => {
    const { container } = render(
      <div className="reader-content">
        <ChapterList firstChapterIndex={0} chaptersHtml={['<p>one</p>', '<h2>two</h2>']} />
      </div>,
    );
    // readerAnchor / restore select ':scope > .chapter' - the structure must stay flat.
    expect(container.querySelectorAll('.reader-content > section.chapter')).toHaveLength(2);
  });
});
