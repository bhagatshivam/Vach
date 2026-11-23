// Adaptive tables: makes every table in a chapter fit the screen without
// sideways scrolling, by measuring it and choosing how to show it.
//
//   fits at the reader's font size  -> shown normally
//   fits when compacted             -> compact (smaller type and padding)
//   still too wide, simple + header -> "cards": each row becomes a bordered
//                                      label/value card
//   still too wide otherwise        -> a small placeholder with an
//                                      "Expand Grid" button (complex tables
//                                      are never flattened to cards)
//
// The decision depends on font size, margins, orientation and screen width, so
// it is never cached across those changes: it is re-run whenever they change
// (TableAdaptController.reevaluate). It runs on the main thread, on mounted
// chapters only, after the HTML has been sanitized.
//
// Two rules keep the reading position valid:
//   - the <table> element itself never moves or is replaced - only classes and
//     data attributes change - so it stays exactly one block (readerAnchor.ts);
//   - anything the reader adds (the placeholder strip and its Expand Grid
//     button) goes INSIDE the table, as a leading <caption>, so it is part of
//     that one block - in the "collapsed" mode it is the whole of what the
//     table shows - and nothing is ever added between blocks.

import { READER_UI_ATTRIBUTE } from './readerAnchor';

export type TableMode = 'normal' | 'compact' | 'cards' | 'collapsed';

export const TABLE_CLASS = 'vach-table';
export const MEASURE_CLASS = 'vach-table-measure';
export const MODE_CLASS: Record<TableMode, string> = {
  normal: 'vach-table-normal',
  compact: 'vach-table-compact',
  cards: 'vach-table-cards',
  collapsed: 'vach-table-collapsed',
};
const ALL_MODE_CLASSES = Object.values(MODE_CLASS);

export const MODE_ATTRIBUTE = 'data-vach-mode';
export const HEADER_ROW_ATTRIBUTE = 'data-vach-header-row';
export const ACTIONS_CLASS = 'vach-table-actions';
export const EXPAND_BUTTON_CLASS = 'vach-table-expand';
export const EXPAND_LABEL = 'Expand Grid';

/**
 * A table that would only fit by being at least this much narrower than the
 * space it has must be that much roomy again before it moves back to a roomier
 * mode (CSS px). Keeps a table from flipping between modes on a one-pixel
 * change of width.
 */
export const HYSTERESIS_PX = 12;

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface TableAnalysis {
  rows: number;
  columns: number;
  /** colspan/rowspan, a nested table, <th> outside the header row, or a multi-row <thead>: never flattened to cards. */
  complex: boolean;
  /** The header row, from <thead> or else a first row made only of <th>; null if there is none. */
  headerRow: HTMLTableRowElement | null;
  /** Header text per column ('' where there is none). Only meaningful for a simple table with a header. */
  labels: string[];
}

const collapse = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ').trim();

function detectHeaderRow(table: HTMLTableElement): HTMLTableRowElement | null {
  const head = table.tHead;
  if (head && head.rows.length > 0) return head.rows[0];
  const first = table.rows[0];
  if (first && first.cells.length > 0 && Array.from(first.cells).every((cell) => cell.tagName === 'TH')) return first;
  return null;
}

export function analyzeTable(table: HTMLTableElement): TableAnalysis {
  const rows = Array.from(table.rows);
  const headerRow = detectHeaderRow(table);

  let columns = 0;
  let spans = false;
  let headerInBody = false;
  for (const row of rows) {
    let width = 0;
    for (const cell of Array.from(row.cells)) {
      width += Math.max(1, cell.colSpan);
      if (cell.colSpan > 1 || cell.rowSpan > 1) spans = true;
      if (cell.tagName === 'TH' && row !== headerRow) headerInBody = true;
    }
    columns = Math.max(columns, width);
  }

  const nested = table.querySelector('table') !== null;
  const multiRowHead = (table.tHead?.rows.length ?? 0) > 1;
  const complex = spans || nested || headerInBody || multiRowHead;

  const labels = headerRow ? Array.from(headerRow.cells).map((cell) => collapse(cell.textContent)) : [];
  return { rows: rows.length, columns, complex, headerRow, labels };
}

// ---------------------------------------------------------------------------
// Normalization: drop publisher geometry and colors
// ---------------------------------------------------------------------------

const RIGID_ATTRIBUTES = ['width', 'height', 'bgcolor', 'background', 'nowrap', 'cellpadding', 'cellspacing', 'border', 'align', 'valign', 'frame', 'rules'];

// Only styling that doesn't affect layout width or fight a theme survives.
const KEPT_STYLE_PROPERTIES = ['text-align', 'font-weight', 'font-style', 'text-decoration'];

/**
 * Strips what makes a publisher's table rigid: fixed widths and heights,
 * nowrap, fixed pixel type sizes, and hard-coded cell/background/text colors
 * (white or black cells break every theme but one). The sanitizer already
 * removes most of this; doing it again here means the adapter does not depend
 * on that, and it is idempotent.
 */
export function normalizeTable(table: HTMLTableElement): void {
  const elements: Element[] = [table, ...Array.from(table.querySelectorAll('*'))];
  for (const el of elements) {
    // Images inside a cell are handled by the image pipeline, not here.
    if (el.tagName === 'IMG') continue;
    for (const attribute of RIGID_ATTRIBUTES) el.removeAttribute(attribute);
    const style = (el as HTMLElement).style;
    if (style && style.length > 0) {
      const kept = KEPT_STYLE_PROPERTIES.map((name) => [name, style.getPropertyValue(name)] as const).filter(([, value]) => value);
      el.removeAttribute('style');
      for (const [name, value] of kept) (el as HTMLElement).style.setProperty(name, value);
    }
  }
  table.classList.add(TABLE_CLASS);
}

// ---------------------------------------------------------------------------
// Decision (pure)
// ---------------------------------------------------------------------------

export interface Fit {
  /** Width the table needs at the reader's font size, with words unbreakable. */
  normalWidth: number;
  /** Width it needs when compacted. */
  compactWidth: number;
  /** Room it has. */
  available: number;
}

/**
 * Chooses a mode. `previous` (the mode it was in) adds hysteresis: moving to a
 * roomier mode than before needs HYSTERESIS_PX of slack, moving to a tighter
 * one does not.
 */
export function planMode(analysis: Pick<TableAnalysis, 'complex' | 'headerRow'>, fit: Fit, previous: TableMode | null): TableMode {
  const slackForNormal = previous === null || previous === 'normal' ? 0 : HYSTERESIS_PX;
  const slackForCompact = previous === null || previous === 'normal' || previous === 'compact' ? 0 : HYSTERESIS_PX;

  if (fit.normalWidth <= fit.available - slackForNormal) return 'normal';
  if (fit.compactWidth <= fit.available - slackForCompact) return 'compact';
  // Still too wide. Cards only for a simple table that has a header to label
  // its cells; anything else must stay a grid, behind a placeholder.
  return !analysis.complex && analysis.headerRow ? 'cards' : 'collapsed';
}

// ---------------------------------------------------------------------------
// Layout reads
// ---------------------------------------------------------------------------

export interface TableLayout {
  /** Room the table has: from its left edge to the right edge of its chapter. */
  available(table: HTMLTableElement): number;
  /** Its rendered width right now. */
  width(table: HTMLTableElement): number;
}

export const domLayout: TableLayout = {
  available(table) {
    const column = table.closest('.chapter') ?? table.parentElement;
    if (!column) return Infinity;
    return column.getBoundingClientRect().right - table.getBoundingClientRect().left;
  },
  width(table) {
    return table.getBoundingClientRect().width;
  },
};

// ---------------------------------------------------------------------------
// Applying a mode
// ---------------------------------------------------------------------------

export function currentMode(table: HTMLTableElement): TableMode | null {
  const value = table.getAttribute(MODE_ATTRIBUTE);
  return value === 'normal' || value === 'compact' || value === 'cards' || value === 'collapsed' ? value : null;
}

/** The reader's own leading <caption>: the placeholder strip / Expand Grid button. */
function actionsIn(table: HTMLTableElement): HTMLElement | null {
  const first = table.firstElementChild;
  return first instanceof HTMLElement && first.classList.contains(ACTIONS_CLASS) ? first : null;
}

function removeActions(table: HTMLTableElement): void {
  actionsIn(table)?.remove();
}

function ensureActions(table: HTMLTableElement, analysis: TableAnalysis, mode: 'cards' | 'collapsed', onExpand: ((table: HTMLTableElement) => void) | undefined): void {
  let actions = actionsIn(table);
  if (!actions) {
    // A <caption> is the one element a table may have as a leading child
    // besides rows. In cards and collapsed modes the table is display: block,
    // so it is laid out as an ordinary block (see App.css) and a book's own
    // caption, if any, is just another block beside it.
    actions = document.createElement('caption');
    actions.className = ACTIONS_CLASS;
    actions.setAttribute(READER_UI_ATTRIBUTE, '');
    table.prepend(actions);
  }
  actions.textContent = '';

  if (mode === 'collapsed') {
    const summary = document.createElement('span');
    summary.className = 'vach-table-summary';
    summary.textContent = `Table \u00b7 ${analysis.rows} rows \u00d7 ${analysis.columns} columns`;
    actions.append(summary);
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = EXPAND_BUTTON_CLASS;
  button.textContent = EXPAND_LABEL;
  button.setAttribute('aria-label', `Expand table, ${analysis.rows} rows by ${analysis.columns} columns`);
  button.addEventListener('click', (event) => {
    // A tap on this button is not a tap on the page (which toggles the header).
    event.stopPropagation();
    onExpand?.(table);
  });
  actions.append(button);
}

function stampLabels(table: HTMLTableElement, analysis: TableAnalysis): void {
  for (const row of Array.from(table.rows)) {
    if (row === analysis.headerRow) {
      row.setAttribute(HEADER_ROW_ATTRIBUTE, '');
      continue;
    }
    Array.from(row.cells).forEach((cell, index) => cell.setAttribute('data-label', analysis.labels[index] ?? ''));
  }
}

function clearLabels(table: HTMLTableElement): void {
  for (const cell of Array.from(table.querySelectorAll('[data-label]'))) cell.removeAttribute('data-label');
  for (const row of Array.from(table.querySelectorAll(`[${HEADER_ROW_ATTRIBUTE}]`))) row.removeAttribute(HEADER_ROW_ATTRIBUTE);
}

function setMode(table: HTMLTableElement, analysis: TableAnalysis, mode: TableMode, onExpand: ((table: HTMLTableElement) => void) | undefined): void {
  table.classList.remove(MEASURE_CLASS, ...ALL_MODE_CLASSES);
  table.classList.add(TABLE_CLASS, MODE_CLASS[mode]);
  table.setAttribute(MODE_ATTRIBUTE, mode);

  if (mode === 'cards') stampLabels(table, analysis);
  else clearLabels(table);

  if (mode === 'cards' || mode === 'collapsed') ensureActions(table, analysis, mode, onExpand);
  else removeActions(table);
}

// ---------------------------------------------------------------------------
// The measure-then-decide pass
// ---------------------------------------------------------------------------

export interface AdaptOptions {
  layout?: TableLayout;
  onExpand?: (table: HTMLTableElement) => void;
}

/** Tables that are not inside another table (inner tables are part of their outer one). */
export function topLevelTables(root: ParentNode): HTMLTableElement[] {
  return Array.from(root.querySelectorAll('table')).filter((table) => !table.parentElement?.closest('table'));
}

/**
 * Adapts the given tables. Synchronous and layout-forcing, so it is meant to
 * run inside a requestAnimationFrame callback. All writes and reads are
 * batched - reset everything, read every width; compact the tight ones, read
 * again; then write every final mode - so it costs two layouts however many
 * tables there are, and nothing is painted in between.
 */
export function adaptTables(tables: HTMLTableElement[], options: AdaptOptions = {}): void {
  if (tables.length === 0) return;
  const layout = options.layout ?? domLayout;

  const entries = tables.map((table) => {
    normalizeTable(table);
    return { table, analysis: analyzeTable(table), previous: currentMode(table), normalWidth: 0, compactWidth: 0, available: 0 };
  });

  // 1. writes: every table to its natural, measurable state
  for (const { table } of entries) {
    table.classList.remove(...ALL_MODE_CLASSES);
    table.classList.add(MEASURE_CLASS);
    removeActions(table);
  }
  // 2. reads
  for (const entry of entries) {
    entry.normalWidth = layout.width(entry.table);
    entry.available = layout.available(entry.table);
  }

  // 3. writes: compact the ones that do not fit as they are
  const tight = entries.filter((entry) => planMode(entry.analysis, { ...entry, compactWidth: Infinity }, entry.previous) !== 'normal');
  for (const { table } of tight) table.classList.add(MODE_CLASS.compact);
  // 4. reads
  for (const entry of tight) entry.compactWidth = layout.width(entry.table);

  // 5. writes: final modes
  for (const entry of entries) {
    const fit: Fit = { normalWidth: entry.normalWidth, compactWidth: entry.compactWidth, available: entry.available };
    setMode(entry.table, entry.analysis, planMode(entry.analysis, fit, entry.previous), options.onExpand);
  }
}

/** A standalone copy of a table for the Expand Grid overlay: no reader classes, labels or chrome. */
export function cloneForGrid(table: HTMLTableElement): HTMLTableElement {
  const clone = table.cloneNode(true) as HTMLTableElement;
  clone.classList.remove(TABLE_CLASS, MEASURE_CLASS, ...ALL_MODE_CLASSES);
  clone.removeAttribute(MODE_ATTRIBUTE);
  removeActions(clone);
  clearLabels(clone);
  clone.classList.add('vach-table-grid');
  return clone;
}

// ---------------------------------------------------------------------------
// Controller: when to adapt
// ---------------------------------------------------------------------------

export interface TableAdaptControllerOptions extends AdaptOptions {
  /**
   * Wraps the DOM writes of one pass so the reader can keep the reading
   * position when table heights change above it. Return what `work` returns.
   */
  preserveView?: (work: () => void) => void;
  /** How far outside the viewport a chapter counts as "in view" (IntersectionObserver rootMargin). */
  rootMargin?: string;
}

/**
 * Decides WHEN to adapt. A chapter's tables are adapted once it mounts and is
 * near the viewport (never for far-off chapters, where reading layout would
 * force layout of content nobody is looking at), and again whenever
 * reevaluate() is called (font size, line height, theme, rotation, resize).
 * Without IntersectionObserver every chapter counts as in view.
 */
export class TableAdaptController {
  private readonly options: TableAdaptControllerOptions;
  private readonly sections = new Map<HTMLElement, { inView: boolean }>();
  private readonly pending = new Set<HTMLElement>();
  private readonly waiters: Array<() => void> = [];
  private observer: IntersectionObserver | null = null;
  private frame: number | null = null;
  private destroyed = false;

  constructor(options: TableAdaptControllerOptions = {}) {
    this.options = options;
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const state = this.sections.get(entry.target as HTMLElement);
            if (!state) continue;
            state.inView = entry.isIntersecting;
            if (entry.isIntersecting) this.schedule(entry.target as HTMLElement);
          }
        },
        { rootMargin: options.rootMargin ?? '100% 0px 100% 0px' },
      );
    }
  }

  /** Starts tracking a mounted chapter. Returns the function that stops. Chapters without tables cost nothing. */
  register(section: HTMLElement): () => void {
    if (this.destroyed || !section.querySelector('table')) return () => {};
    this.sections.set(section, { inView: !this.observer });
    if (this.observer) this.observer.observe(section);
    else this.schedule(section);
    return () => {
      this.sections.delete(section);
      this.pending.delete(section);
      this.observer?.unobserve(section);
    };
  }

  /**
   * Re-runs the decision for every chapter that is near the viewport (others
   * re-run when they come into view). Resolves once that pass has been
   * written. `preserveView: false` skips the view-keeping wrapper, for a
   * caller that restores the reading position itself afterwards.
   */
  reevaluate(options: { preserveView?: boolean } = {}): Promise<void> {
    this.skipPreserve = options.preserveView === false;
    for (const [section, state] of this.sections) if (state.inView) this.schedule(section);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      if (this.pending.size === 0) this.flush();
      else this.requestFlush();
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.observer?.disconnect();
    this.sections.clear();
    this.pending.clear();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.release();
  }

  private skipPreserve = false;

  private schedule(section: HTMLElement): void {
    this.pending.add(section);
    this.requestFlush();
  }

  private requestFlush(): void {
    if (this.frame !== null || this.destroyed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.flush();
    });
  }

  private flush(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    const sections = Array.from(this.pending).filter((section) => section.isConnected);
    this.pending.clear();
    const tables = sections.flatMap((section) => topLevelTables(section));

    if (tables.length > 0) {
      const run = () => adaptTables(tables, this.options);
      if (this.options.preserveView && !this.skipPreserve) this.options.preserveView(run);
      else run();
    }
    this.skipPreserve = false;
    this.release();
  }

  private release(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

/**
 * Calls `onChange` (debounced) when the element's WIDTH changes - rotation,
 * split-screen, a foldable opening - ignoring height changes, which table
 * adaptation itself causes. Without ResizeObserver, falls back to the window's
 * resize event. Returns the function that stops.
 */
export function watchWidth(element: HTMLElement, onChange: () => void, debounceMs = 150): () => void {
  let last = element.getBoundingClientRect().width;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = (width: number) => {
    if (Math.abs(width - last) < 0.5) return;
    last = width;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };

  let stop: () => void;
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) changed(entry.contentRect.width);
    });
    observer.observe(element);
    stop = () => observer.disconnect();
  } else {
    const onResize = () => changed(element.getBoundingClientRect().width);
    window.addEventListener('resize', onResize);
    stop = () => window.removeEventListener('resize', onResize);
  }
  return () => {
    stop();
    if (timer !== null) clearTimeout(timer);
  };
}
