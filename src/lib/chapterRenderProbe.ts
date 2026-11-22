// Test seam: lets a test count how many times a chapter section actually
// renders (see components/ChapterList.tsx). Null - and free - in production.
export const chapterRenderProbe: { onRender: ((chapterIndex: number) => void) | null } = { onRender: null };
