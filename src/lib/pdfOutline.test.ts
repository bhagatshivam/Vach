import { describe, expect, it, vi } from 'vitest';
import { resolvePdfOutline, type PdfDestinationResolver, type PdfOutlineNode } from './pdf';
import { flattenToc } from './toc';

// pdf.js is not needed to prove the resolution logic: the two document lookups are mocked.

const refFor = (page: number) => ({ num: 100 + page, gen: 0 });
const pageOfRef = new Map<number, number>([5, 0, 1, 2, 9].map((p) => [100 + p, p]));

function resolver(overrides: Partial<PdfDestinationResolver> = {}): PdfDestinationResolver {
  return {
    getDestination: async (name) => (name === 'chap2' ? [refFor(2), { name: 'XYZ' }, 0, 0, null] : name === 'gone' ? null : [refFor(9)]),
    getPageIndex: async (ref) => {
      const page = pageOfRef.get((ref as { num: number }).num);
      if (page === undefined) throw new Error('Invalid page request');
      return page;
    },
    ...overrides,
  };
}

const view = (items: ReturnType<typeof flattenToc>) => items.map((i) => `${'-'.repeat(i.depth)}${i.title}>${i.chapterIndex}`);

describe('resolvePdfOutline', () => {
  it('resolves explicit destinations, named destinations and a bare page index to page indexes, keeping the nesting', async () => {
    const outline: PdfOutlineNode[] = [
      { title: 'Intro', dest: [refFor(0), { name: 'Fit' }], items: [{ title: 'Why', dest: [refFor(1)] }] },
      { title: 'Chapter 2', dest: 'chap2' },
      { title: 'By index', dest: [4] },
    ];
    const toc = await resolvePdfOutline(outline, resolver(), 10);
    expect(view(flattenToc(toc))).toEqual(['Intro>0', '-Why>1', 'Chapter 2>2', 'By index>4']);
    expect(toc[0].children[0].depth).toBe(1);
    expect(new Set(flattenToc(toc).map((i) => i.id)).size).toBe(4);
  });

  it('drops what cannot be resolved: a web link, a missing named destination, a broken reference, a page outside the document', async () => {
    const outline: PdfOutlineNode[] = [
      { title: 'Website', dest: null },
      { title: 'Lost name', dest: 'gone' },
      { title: 'Broken ref', dest: [{ num: 999, gen: 0 }] },
      { title: 'Past the end', dest: [50] },
      { title: 'Negative', dest: [-1] },
      { title: 'Fine', dest: [refFor(1)] },
    ];
    expect(view(flattenToc(await resolvePdfOutline(outline, resolver(), 10)))).toEqual(['Fine>1']);
  });

  it('a heading that does not resolve but has entries beneath it opens the first of them', async () => {
    const outline: PdfOutlineNode[] = [{ title: 'Part I', dest: null, items: [{ title: 'Ch 1', dest: [refFor(2)] }, { title: 'Ch 2', dest: [refFor(5)] }] }];
    expect(view(flattenToc(await resolvePdfOutline(outline, resolver(), 10)))).toEqual(['Part I>2', '-Ch 1>2', '-Ch 2>5']);
  });

  it('an empty or missing title becomes "Page N"; whitespace is collapsed', async () => {
    const outline: PdfOutlineNode[] = [{ title: '   ', dest: [refFor(2)] }, { dest: [refFor(5)] }, { title: ' A \n  B ', dest: [refFor(1)] }];
    expect(flattenToc(await resolvePdfOutline(outline, resolver(), 10)).map((i) => i.title)).toEqual(['Page 3', 'Page 6', 'A B']);
  });

  it('a lookup that throws loses only that entry', async () => {
    const getDestination = vi.fn(async (name: string) => {
      if (name === 'boom') throw new Error('worker died');
      return [refFor(1)];
    });
    const outline: PdfOutlineNode[] = [{ title: 'Boom', dest: 'boom' }, { title: 'OK', dest: 'fine' }];
    expect(view(flattenToc(await resolvePdfOutline(outline, resolver({ getDestination }), 10)))).toEqual(['OK>1']);
  });

  it('no outline gives an empty list', async () => {
    expect(await resolvePdfOutline(null, resolver(), 10)).toEqual([]);
    expect(await resolvePdfOutline(undefined, resolver(), 10)).toEqual([]);
    expect(await resolvePdfOutline([], resolver(), 10)).toEqual([]);
  });

  it('handles an outline of a few hundred entries', async () => {
    const outline: PdfOutlineNode[] = Array.from({ length: 300 }, (_, i) => ({ title: `E${i}`, dest: [i % 10] }));
    expect(flattenToc(await resolvePdfOutline(outline, resolver({ getPageIndex: async (ref) => (ref as number) }), 10))).toHaveLength(300);
  });
});
