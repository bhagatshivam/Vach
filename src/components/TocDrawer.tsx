import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { currentTocItem, flattenToc, hasDeepNesting, pathTo, type TocItem } from '../lib/toc';
import '../toc.css';

// The reader's "Contents" drawer: slides in from the left over a dimmed page,
// shows the book's table of contents with the current entry highlighted (and
// scrolled into view), and overall progress at the top. Tapping an entry jumps
// there; tapping outside, the close button, Escape or the hardware Back button
// closes it. Looks come from the reader's own theme (passed as `themeStyle`)
// and the safe-area insets, so it sits correctly under the system bars.

interface TocDrawerProps {
  items: readonly TocItem[];
  /** The chapter the reader is in now (its index), to highlight the current entry. */
  currentChapterIndex: number;
  /** Overall progress through the book, 0..1. */
  progress: number;
  /** Background/text colours of the reading theme. */
  themeStyle: CSSProperties;
  onSelect: (item: TocItem) => void;
  onClose: () => void;
}

export default function TocDrawer({ items, currentChapterIndex, progress, themeStyle, onSelect, onClose }: TocDrawerProps) {
  const current = useMemo(() => currentTocItem(items, currentChapterIndex), [items, currentChapterIndex]);
  const deep = useMemo(() => hasDeepNesting(items), [items]);

  // Collapsing is only offered for a deeply nested book. Groups below the top
  // level start collapsed, except the ones that lead to the current entry.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    if (!hasDeepNesting(items)) return new Set();
    const open = new Set(current ? pathTo(items, current).map((item) => item.id) : []);
    return new Set(flattenToc(items).filter((item) => item.depth >= 1 && item.children.length > 0 && !open.has(item.id)).map((item) => item.id));
  });

  const closeRef = useRef<HTMLButtonElement>(null);
  const currentRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Opened on the current entry, not at the top of a long list.
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'center' });
  }, []);

  function toggle(id: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const percent = Number.isFinite(progress) ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : 0;

  function renderList(list: readonly TocItem[]) {
    return (
      <ul className="toc-list">
        {list.map((item) => {
          const isCurrent = item === current;
          const canCollapse = deep && item.depth >= 1 && item.children.length > 0;
          const isCollapsed = canCollapse && collapsed.has(item.id);
          return (
            <li key={item.id} ref={isCurrent ? currentRef : undefined}>
              <div className={`toc-row${isCurrent ? ' current' : ''}`} style={{ paddingLeft: `${16 + item.depth * 16}px` }}>
                {canCollapse && (
                  <button
                    type="button"
                    className="toc-toggle"
                    aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${item.title}`}
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(item.id)}
                  >
                    {isCollapsed ? '▸' : '▾'}
                  </button>
                )}
                <button type="button" className="toc-item" aria-current={isCurrent ? 'true' : undefined} onClick={() => onSelect(item)}>
                  {item.title}
                </button>
              </div>
              {item.children.length > 0 && !isCollapsed && renderList(item.children)}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="toc-overlay" role="dialog" aria-modal="true" aria-label="Contents">
      <div className="toc-backdrop" onClick={onClose} />
      <aside className="toc-panel" style={themeStyle}>
        <header className="toc-header">
          <h2>Contents</h2>
          <button ref={closeRef} type="button" className="toc-close" aria-label="Close" onClick={onClose}>
            &times;
          </button>
        </header>
        <div className="toc-progress">
          <span className="toc-percent">{percent}%</span>
          <div className="toc-bar" role="progressbar" aria-label="Book progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className="toc-bar-fill" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <nav className="toc-scroll">{renderList(items)}</nav>
      </aside>
    </div>
  );
}
