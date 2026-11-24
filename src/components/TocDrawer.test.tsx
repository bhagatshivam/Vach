import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import TocDrawer from './TocDrawer';
import type { TocItem } from '../lib/toc';

const item = (id: string, title: string, chapterIndex: number, depth = 0, children: TocItem[] = []): TocItem => ({ id, title, chapterIndex, depth, children });

const flat: TocItem[] = [item('a', 'Prologue', 0), item('b', 'Chapter One', 1), item('c', 'Chapter Two', 5), item('d', 'Epilogue', 9)];
const deep: TocItem[] = [
  item('p1', 'Part One', 0, 0, [item('b1', 'Book A', 1, 1, [item('s1', 'Section A1', 1, 2), item('s2', 'Section A2', 2, 2)]), item('b2', 'Book B', 4, 1, [item('s3', 'Section B1', 4, 2)])]),
  item('p2', 'Part Two', 8, 0),
];

const themeStyle = { background: '#121212', color: '#d8d8d8' };

function renderDrawer(props: Partial<React.ComponentProps<typeof TocDrawer>> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const view = render(<TocDrawer items={flat} currentChapterIndex={0} progress={0.42} themeStyle={themeStyle} onSelect={onSelect} onClose={onClose} {...props} />);
  return { ...view, onSelect, onClose };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TocDrawer', () => {
  it('is a dialog named Contents listing every entry, in the reader theme', () => {
    renderDrawer();
    const dialog = screen.getByRole('dialog', { name: 'Contents' });
    expect(within(dialog).getAllByRole('button', { name: /Prologue|Chapter One|Chapter Two|Epilogue/ })).toHaveLength(4);
    expect(dialog.querySelector<HTMLElement>('.toc-panel')!.style.background).toBe('rgb(18, 18, 18)');
  });

  it('shows overall progress as a percentage and a slim bar', () => {
    renderDrawer({ progress: 0.426 });
    expect(screen.getByText('43%')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Book progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('43');
    expect(bar.querySelector<HTMLElement>('.toc-bar-fill')!.style.width).toBe('43%');
  });

  it('clamps nonsense progress to 0..100', () => {
    renderDrawer({ progress: 7 });
    expect(screen.getByText('100%')).toBeTruthy();
    cleanup();
    renderDrawer({ progress: Number.NaN });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });

  it.each([
    [0, 'Prologue'],
    [3, 'Chapter One'],
    [5, 'Chapter Two'],
    [7, 'Chapter Two'],
    [20, 'Epilogue'],
  ])('at chapter %i the current entry is %s', (chapter, title) => {
    renderDrawer({ currentChapterIndex: chapter });
    const current = document.querySelectorAll('[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toBe(title);
    expect(current[0].closest('.toc-row')!.classList.contains('current')).toBe(true);
  });

  it('highlights nothing before the first entry', () => {
    renderDrawer({ items: [item('x', 'Later', 4)], currentChapterIndex: 1 });
    expect(document.querySelector('[aria-current]')).toBeNull();
  });

  it('scrolls the current entry into view when opened', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderDrawer({ currentChapterIndex: 5 });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(document.querySelector('[aria-current="true"]')!.closest('li'));
    // @ts-expect-error jsdom does not define it
    delete Element.prototype.scrollIntoView;
  });

  it('tapping an entry selects exactly that entry', () => {
    const { onSelect, onClose } = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Chapter Two' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe(flat[2]);
    expect(onClose).not.toHaveBeenCalled(); // the reader closes it as part of jumping
  });

  it('closes from the close button, the backdrop and Escape - and not from a tap inside the panel', () => {
    const { onClose, container } = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('.toc-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.click(container.querySelector('.toc-panel')!);
    fireEvent.keyDown(document, { key: 'a' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('indents nested entries by depth', () => {
    renderDrawer({ items: [item('a', 'Top', 0, 0, [item('b', 'Child', 1, 1)])] });
    const pad = (name: string) => screen.getByRole('button', { name }).closest<HTMLElement>('.toc-row')!.style.paddingLeft;
    expect(pad('Top')).toBe('16px');
    expect(pad('Child')).toBe('32px');
  });
});

describe('TocDrawer - deep nesting', () => {
  it('offers no collapse toggles for a book that is not deeply nested', () => {
    renderDrawer({ items: [item('a', 'Top', 0, 0, [item('b', 'Child', 1, 1, [])])] });
    expect(screen.queryByRole('button', { name: /^(Collapse|Expand)/ })).toBeNull();
  });

  it('three levels deep: toggles only below the top level; other groups start collapsed, the current one open', () => {
    renderDrawer({ items: deep, currentChapterIndex: 2 }); // current: Section A2
    // Top level is never collapsible and always open.
    expect(screen.queryByRole('button', { name: /(Collapse|Expand) Part/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Book A' })).toBeTruthy();
    // The path to the current entry is open...
    expect(screen.getByRole('button', { name: 'Section A2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse Book A' }).getAttribute('aria-expanded')).toBe('true');
    // ...the other group is collapsed.
    expect(screen.getByRole('button', { name: 'Expand Book B' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Section B1' })).toBeNull();
  });

  it('toggling expands and collapses, and tapping a collapsed group title still jumps', () => {
    const { onSelect } = renderDrawer({ items: deep, currentChapterIndex: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Expand Book B' }));
    expect(screen.getByRole('button', { name: 'Section B1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Book A' }));
    expect(screen.queryByRole('button', { name: 'Section A2' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Book A' }));
    expect(onSelect.mock.calls[0][0].title).toBe('Book A');
  });
});
