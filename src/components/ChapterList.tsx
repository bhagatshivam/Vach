import { memo, useContext, useEffect, useRef } from 'react';
import { chapterRenderProbe } from '../lib/chapterRenderProbe';
import { ImageContext } from './imageContext';
import { PdfPageLoaderContext } from './pdfPageLoaderContext';
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
  const tables = useContext(TableAdaptContext);
  const images = useContext(ImageContext);
  const pages = useContext(PdfPageLoaderContext);
  const sectionRef = useRef<HTMLElement>(null);

  // Once this chapter's HTML is in the DOM, hand it to the table adapter and
  // the image controller. Each measures/processes only what is near the
  // viewport and ignores chapters with nothing for it. (Registering is an
  // effect on the DOM node, not a render: a chapter still renders exactly once.)
  // Only a window of the book is mounted (mountWindow.ts), so a chapter that is
  // unmounted runs the cleanup below: the table adapter forgets its tables, the
  // image controller stops watching its pictures and lets go of them (the store
  // revokes the blob: URLs nobody else is showing). A chapter that comes back
  // mounts as new and is registered afresh. A PDF page's placeholder goes to the
  // page loader the same way: it rasterizes the page while it is near the screen
  // and lets go of it when the chapter unmounts.
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const stops = [tables?.register(section), images?.register(section), pages?.register(section)];
    return () => {
      for (const stop of stops) stop?.();
    };
  }, [tables, images, pages]);

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
