import { memo } from 'react';
import { chapterRenderProbe } from '../lib/chapterRenderProbe';

interface ChapterSectionProps {
  /** The chapter's index in the book - also its React key, so it is stable when earlier chapters are prepended. */
  index: number;
  /** Already-sanitized HTML. A string, so memo compares it by value. */
  html: string;
}

/**
 * One chapter. Memoized on (index, html): once a chapter is mounted, appending
 * or prepending other chapters never re-renders it or touches its DOM.
 */
export const ChapterSection = memo(function ChapterSection({ index, html }: ChapterSectionProps) {
  chapterRenderProbe.onRender?.(index);
  return <section className="chapter" dangerouslySetInnerHTML={{ __html: html }} />;
});

interface ChapterListProps {
  /** Book index of chaptersHtml[0]. */
  firstChapterIndex: number;
  chaptersHtml: string[];
}

export function ChapterList({ firstChapterIndex, chaptersHtml }: ChapterListProps) {
  return (
    <>
      {chaptersHtml.map((html, i) => (
        <ChapterSection key={firstChapterIndex + i} index={firstChapterIndex + i} html={html} />
      ))}
    </>
  );
}
