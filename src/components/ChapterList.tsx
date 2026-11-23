import { memo, useContext, useEffect, useRef } from 'react';
import { chapterRenderProbe } from '../lib/chapterRenderProbe';
import { TableAdaptContext } from './tableAdaptContext';

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
  const controller = useContext(TableAdaptContext);
  const sectionRef = useRef<HTMLElement>(null);

  // Once this chapter's HTML is in the DOM, hand it to the table adapter. The
  // adapter measures it when it is near the viewport and ignores chapters
  // without tables. (Registering is an effect on the DOM node, not a render:
  // a chapter still renders exactly once.)
  useEffect(() => {
    const section = sectionRef.current;
    if (!controller || !section) return;
    return controller.register(section);
  }, [controller]);

  return <section ref={sectionRef} className="chapter" dangerouslySetInnerHTML={{ __html: html }} />;
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
