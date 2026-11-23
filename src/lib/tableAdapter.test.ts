import { afterEach, describe, expect, it, vi } from 'vitest';
import { flattenToLeafBlocks } from './readerAnchor';
import {
  ACTIONS_CLASS,
  EXPAND_BUTTON_CLASS,
  EXPAND_LABEL,
  HEADER_ROW_ATTRIBUTE,
  HYSTERESIS_PX,
  MEASURE_CLASS,
  MODE_CLASS,
  TableAdaptController,
  adaptTables,
  analyzeTable,
  cloneForGrid,
  currentMode,
  normalizeTable,
  planMode,
  topLevelTables,
  watchWidth,
  type TableLayout,
} from './tableAdapter';

// jsdom computes no layout, so widths come from a model: a table needs
// `perColumn` px per column (less when compacted), and has `room` px.
function layoutOf(room: { value: number }, perColumn = { normal: 100, compact: 60 }): TableLayout {
  return {
    available: () => room.value,
    width: (table) => analyzeTable(table).columns * (table.classList.contains(MODE_CLASS.compact) ? perColumn.compact : perColumn.normal),
  };
}

function build(html: string): { chapter: HTMLElement; tables: HTMLTableElement[] } {
  document.body.innerHTML = `<section class="chapter">${html}</section>`;
  const chapter = document.querySelector('section.chapter') as HTMLElement;
  return { chapter, tables: topLevelTables(chapter) };
}

const cells = (n: number, tag = 'td', text = 'x') => Array.from({ length: n }, (_, i) => `<${tag}>${text}${i}</${tag}>`).join('');
const headed = (columns: number, bodyRows = 3) =>
  `<table><thead><tr>${cells(columns, 'th', 'H')}</tr></thead><tbody>${Array.from({ length: bodyRows }, () => `<tr>${cells(columns)}</tr>`).join('')}</tbody></table>`;
const headerless = (columns: number, rows = 3) => `<table><tbody>${Array.from({ length: rows }, () => `<tr>${cells(columns)}</tr>`).join('')}</tbody></table>`;

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('analyzeTable', () => {
  it('a thead table is a simple table with that header and its labels', () => {
    const { tables } = build(headed(3));
    const analysis = analyzeTable(tables[0]);
    expect(analysis.complex).toBe(false);
    expect(analysis.headerRow).toBe(tables[0].tHead!.rows[0]);
    expect(analysis.labels).toEqual(['H0', 'H1', 'H2']);
    expect(analysis.rows).toBe(4);
    expect(analysis.columns).toBe(3);
  });

  it('with no thead, a first row made only of <th> is the header', () => {
    const { tables } = build('<table><tbody><tr><th>Name</th><th>Level</th></tr><tr><td>Kaito</td><td>12</td></tr></tbody></table>');
    const analysis = analyzeTable(tables[0]);
    expect(analysis.headerRow).toBe(tables[0].rows[0]);
    expect(analysis.labels).toEqual(['Name', 'Level']);
    expect(analysis.complex).toBe(false);
  });

  it('a first row of mixed <th>/<td> is not a header', () => {
    const { tables } = build('<table><tbody><tr><th>Name</th><td>Kaito</td></tr><tr><th>Level</th><td>12</td></tr></tbody></table>');
    const analysis = analyzeTable(tables[0]);
    expect(analysis.headerRow).toBeNull();
    expect(analysis.complex).toBe(true); // <th> row headers inside the body
  });

  it('a table with no <th> at all has no header', () => {
    const { tables } = build(headerless(4));
    expect(analyzeTable(tables[0]).headerRow).toBeNull();
    expect(analyzeTable(tables[0]).labels).toEqual([]);
  });

  it.each([
    ['colspan', '<table><tbody><tr><td colspan="2">a</td></tr><tr><td>b</td><td>c</td></tr></tbody></table>'],
    ['rowspan', '<table><tbody><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>'],
    ['a nested table', '<table><tbody><tr><td><table><tbody><tr><td>inner</td></tr></tbody></table></td></tr></tbody></table>'],
    ['<th> inside <tbody> (row headers)', '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><th>row</th><td>1</td></tr></tbody></table>'],
    ['a multi-row <thead>', '<table><thead><tr><th>A</th><th>B</th></tr><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'],
  ])('%s makes a table complex', (_label, markup) => {
    const { tables } = build(markup);
    expect(analyzeTable(tables[0]).complex).toBe(true);
  });

  it('colspan="1" and rowspan="1" are not spans', () => {
    const { tables } = build('<table><tbody><tr><td colspan="1" rowspan="1">a</td><td>b</td></tr></tbody></table>');
    expect(analyzeTable(tables[0]).complex).toBe(false);
  });

  it('counts columns across colspans, and rows without counting nested ones', () => {
    const { tables } = build(
      '<table><tbody><tr><td colspan="3">wide</td></tr><tr><td>a</td><td>b</td><td><table><tbody><tr><td>i</td></tr><tr><td>j</td></tr></tbody></table></td></tr></tbody></table>',
    );
    const analysis = analyzeTable(tables[0]);
    expect(analysis.columns).toBe(3);
    expect(analysis.rows).toBe(2);
  });

  it('topLevelTables ignores tables nested in other tables', () => {
    const { tables } = build(`${headerless(2)}<table><tbody><tr><td><table><tbody><tr><td>i</td></tr></tbody></table></td></tr></tbody></table>`);
    expect(tables).toHaveLength(2);
  });
});

describe('normalizeTable - publisher rigidity is stripped', () => {
  it('removes widths, heights, nowrap, colors and fixed sizes, keeps alignment and weight', () => {
    const { tables } = build(
      '<table width="900" height="400" bgcolor="#fff" border="1" style="width:900px;background:#fff;color:#000"><colgroup><col width="300"></colgroup><tbody><tr height="50"><td width="300" nowrap bgcolor="white" style="white-space:nowrap;min-width:300px;font-size:11px;background-color:#fff;color:#000;text-align:right;font-weight:700">x</td></tr></tbody></table>',
    );
    normalizeTable(tables[0]);
    const html = tables[0].outerHTML;
    expect(html).not.toMatch(/width|height|bgcolor|nowrap|border=|background|color|font-size|white-space/);
    const td = tables[0].querySelector('td') as HTMLElement;
    expect(td.style.textAlign).toBe('right');
    expect(td.style.fontWeight).toBe('700');
    expect(tables[0].classList.contains('vach-table')).toBe(true);
  });

  it('leaves images inside cells alone', () => {
    const { tables } = build('<table><tbody><tr><td><img src="data:image/png;base64,AA==" width="64" height="32"></td></tr></tbody></table>');
    normalizeTable(tables[0]);
    const img = tables[0].querySelector('img')!;
    expect(img.getAttribute('width')).toBe('64');
    expect(img.getAttribute('height')).toBe('32');
  });

  it('is idempotent', () => {
    const { tables } = build('<table width="500"><tbody><tr><td width="9">x</td></tr></tbody></table>');
    normalizeTable(tables[0]);
    const once = tables[0].outerHTML;
    normalizeTable(tables[0]);
    expect(tables[0].outerHTML).toBe(once);
  });
});

describe('planMode (the decision)', () => {
  const simple = { complex: false, headerRow: {} as HTMLTableRowElement };
  const complex = { complex: true, headerRow: {} as HTMLTableRowElement };
  const noHeader = { complex: false, headerRow: null };

  it('fits as it is -> normal', () => {
    expect(planMode(simple, { normalWidth: 300, compactWidth: 200, available: 320 }, null)).toBe('normal');
    expect(planMode(simple, { normalWidth: 320, compactWidth: 200, available: 320 }, null)).toBe('normal'); // exactly fits
  });

  it('tight: fits once compacted -> compact', () => {
    expect(planMode(simple, { normalWidth: 400, compactWidth: 300, available: 320 }, null)).toBe('compact');
  });

  it('still too wide -> cards for a simple table with a header', () => {
    expect(planMode(simple, { normalWidth: 900, compactWidth: 600, available: 320 }, null)).toBe('cards');
  });

  it('still too wide -> a complex table is NEVER cards: collapsed behind Expand Grid', () => {
    expect(planMode(complex, { normalWidth: 900, compactWidth: 600, available: 320 }, null)).toBe('collapsed');
  });

  it('still too wide -> a table with no header is NEVER cards: collapsed', () => {
    expect(planMode(noHeader, { normalWidth: 900, compactWidth: 600, available: 320 }, null)).toBe('collapsed');
  });

  it('a complex table that fits compacted is shown normally (compact), not collapsed', () => {
    expect(planMode(complex, { normalWidth: 500, compactWidth: 300, available: 320 }, null)).toBe('compact');
  });

  it('hysteresis: a compact table does not return to normal until it fits with slack to spare', () => {
    const justFits = { normalWidth: 320, compactWidth: 200, available: 320 };
    expect(planMode(simple, justFits, 'compact')).toBe('compact');
    expect(planMode(simple, { ...justFits, available: 320 + HYSTERESIS_PX - 1 }, 'compact')).toBe('compact');
    expect(planMode(simple, { ...justFits, available: 320 + HYSTERESIS_PX }, 'compact')).toBe('normal');
  });

  it('hysteresis: cards go back to compact, and collapsed back to compact, only with slack', () => {
    const fit = { normalWidth: 900, compactWidth: 320, available: 320 };
    expect(planMode(simple, fit, 'cards')).toBe('cards');
    expect(planMode(simple, { ...fit, available: 320 + HYSTERESIS_PX }, 'cards')).toBe('compact');
    expect(planMode(noHeader, fit, 'collapsed')).toBe('collapsed');
    expect(planMode(noHeader, { ...fit, available: 320 + HYSTERESIS_PX }, 'collapsed')).toBe('compact');
  });

  it('getting tighter never needs slack', () => {
    expect(planMode(simple, { normalWidth: 321, compactWidth: 100, available: 320 }, 'normal')).toBe('compact');
    expect(planMode(simple, { normalWidth: 900, compactWidth: 321, available: 320 }, 'compact')).toBe('cards');
  });
});

describe('adaptTables', () => {
  const room = { value: 360 };

  it('a narrow 3-column table fits: normal, no chrome, no labels', () => {
    room.value = 360;
    const { tables } = build(headed(3));
    adaptTables(tables, { layout: layoutOf(room) });
    expect(currentMode(tables[0])).toBe('normal');
    expect(tables[0].classList.contains(MODE_CLASS.normal)).toBe(true);
    expect(tables[0].classList.contains(MEASURE_CLASS)).toBe(false);
    expect(document.querySelector(`.${ACTIONS_CLASS}`)).toBeNull();
    expect(document.querySelector('[data-label]')).toBeNull();
  });

  it('a tight 5-column table becomes compact', () => {
    room.value = 360; // 5 x 100 = 500 normal, 5 x 60 = 300 compact
    const { tables } = build(headed(5));
    adaptTables(tables, { layout: layoutOf(room) });
    expect(currentMode(tables[0])).toBe('compact');
    expect(tables[0].classList.contains(MEASURE_CLASS)).toBe(false);
  });

  it('a wide 9-column table with a header becomes cards: data-label on every cell, header row marked, Expand Grid offered', () => {
    room.value = 360; // 9 x 60 = 540 compact: still too wide
    const { tables } = build(headed(9, 2));
    adaptTables(tables, { layout: layoutOf(room) });
    expect(currentMode(tables[0])).toBe('cards');
    expect(tables[0].querySelector(`tr[${HEADER_ROW_ATTRIBUTE}]`)).not.toBeNull();
    const bodyCells = Array.from(tables[0].tBodies[0].querySelectorAll('td'));
    expect(bodyCells).toHaveLength(18);
    expect(bodyCells.slice(0, 9).map((c) => c.getAttribute('data-label'))).toEqual(['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8']);
    const button = document.querySelector(`.${ACTIONS_CLASS} .${EXPAND_BUTTON_CLASS}`);
    expect(button?.textContent).toBe(EXPAND_LABEL);
    expect(document.querySelector('.vach-table-summary')).toBeNull(); // cards show the cards, not a placeholder
  });

  it('a wide headerless table is collapsed behind a "Table, N rows x M columns" placeholder with Expand Grid - never cards', () => {
    room.value = 360;
    const { tables } = build(headerless(9, 4));
    adaptTables(tables, { layout: layoutOf(room) });
    expect(currentMode(tables[0])).toBe('collapsed');
    expect(document.querySelector('[data-label]')).toBeNull();
    expect(document.querySelector('.vach-table-summary')?.textContent).toBe('Table · 4 rows × 9 columns');
    expect(document.querySelector(`.${EXPAND_BUTTON_CLASS}`)?.textContent).toBe(EXPAND_LABEL);
  });

  it.each([
    ['colspan', '<table><thead><tr>' + cells(9, 'th', 'H') + '</tr></thead><tbody><tr><td colspan="9">span</td></tr><tr>' + cells(9) + '</tr></tbody></table>'],
    ['rowspan', '<table><thead><tr>' + cells(9, 'th', 'H') + '</tr></thead><tbody><tr><td rowspan="2">r</td>' + cells(8) + '</tr><tr>' + cells(8) + '</tr></tbody></table>'],
    ['a nested table', '<table><thead><tr>' + cells(9, 'th', 'H') + '</tr></thead><tbody><tr><td><table><tbody><tr><td>i</td></tr></tbody></table></td>' + cells(8) + '</tr></tbody></table>'],
    ['<th> in <tbody>', '<table><thead><tr>' + cells(9, 'th', 'H') + '</tr></thead><tbody><tr><th>row</th>' + cells(8) + '</tr></tbody></table>'],
  ])('a wide complex table (%s) is never flattened to cards: collapsed with a placeholder', (_label, markup) => {
    room.value = 360;
    const { tables } = build(markup);
    adaptTables(tables, { layout: layoutOf(room) });
    expect(currentMode(tables[0])).toBe('collapsed');
    expect(tables[0].classList.contains(MODE_CLASS.cards)).toBe(false);
    expect(document.querySelector('[data-label]')).toBeNull();
    expect(document.querySelector('.vach-table-summary')).not.toBeNull();
  });

  it('a complex table that fits when compacted is rendered normally, not collapsed', () => {
    room.value = 360;
    const { tables } = build('<table><tbody><tr><td colspan="2">span</td><td>a</td><td>b</td><td>c</td></tr><tr>' + cells(5) + '</tr></tbody></table>');
    adaptTables(tables, { layout: layoutOf(room) });
    expect(currentMode(tables[0])).toBe('compact');
    expect(document.querySelector(`.${ACTIONS_CLASS}`)).toBeNull();
  });

  it('a publisher-styled table (fixed widths, white cells, nowrap) is stripped, then measured like any other', () => {
    room.value = 360;
    const { tables } = build(
      '<table width="800" style="width:800px;background:#fff"><thead><tr><th width="400" nowrap>A</th><th width="400" nowrap>B</th></tr></thead><tbody><tr><td bgcolor="white" style="white-space:nowrap;background-color:#ffffff">1</td><td>2</td></tr></tbody></table>',
    );
    adaptTables(tables, { layout: layoutOf(room) });
    expect(currentMode(tables[0])).toBe('normal');
    expect(tables[0].outerHTML).not.toMatch(/width|bgcolor|nowrap|background|white-space/);
  });

  it('measures in a batch: several tables, each decided on its own width', () => {
    room.value = 360;
    const { tables } = build(headed(2) + headed(5) + headed(9) + headerless(9));
    adaptTables(tables, { layout: layoutOf(room) });
    expect(tables.map(currentMode)).toEqual(['normal', 'compact', 'cards', 'collapsed']);
  });

  it('a table stays exactly one block in every mode, and reader chrome is never a block', () => {
    for (const available of [1000, 360, 200]) {
      room.value = available;
      const { chapter, tables } = build(`<p>before</p>${headed(9)}<p>after</p>`);
      const before = flattenToLeafBlocks(chapter).map((b) => b.tagName);
      adaptTables(tables, { layout: layoutOf(room) });
      const after = flattenToLeafBlocks(chapter).map((b) => b.tagName);
      expect(after).toEqual(before);
      expect(after).toEqual(['P', 'TABLE', 'P']);
    }
  });

  it('puts the placeholder / Expand Grid chrome INSIDE the table, as its leading <caption>, never between blocks', () => {
    const room = { value: 360 };
    const { chapter, tables } = build(`<p>before</p>${headerless(9, 4)}<p>after</p>`);
    adaptTables(tables, { layout: layoutOf(room) });
    const actions = tables[0].firstElementChild as HTMLElement;
    expect(actions.tagName).toBe('CAPTION');
    expect(actions.classList.contains(ACTIONS_CLASS)).toBe(true);
    expect(actions.hasAttribute('data-vach-ui')).toBe(true);
    expect(Array.from(chapter.children).map((c) => c.tagName)).toEqual(['P', 'TABLE', 'P']);
  });

  it('keeps a book\'s own <caption> and adds the strip beside it, then removes only its own', () => {
    const room = { value: 360 };
    const { tables } = build(`<table><caption>Party stats</caption><thead><tr>${cells(9, 'th', 'H')}</tr></thead><tbody><tr>${cells(9)}</tr></tbody></table>`);
    adaptTables(tables, { layout: layoutOf(room) });
    expect(tables[0].querySelectorAll('caption')).toHaveLength(2);
    room.value = 5000;
    adaptTables(tables, { layout: layoutOf(room) });
    const captions = tables[0].querySelectorAll('caption');
    expect(captions).toHaveLength(1);
    expect(captions[0].textContent).toBe('Party stats');
  });

  it('is a no-op for an empty list', () => {
    expect(() => adaptTables([])).not.toThrow();
  });
});

describe('re-evaluation: nothing is cached across width changes', () => {
  it('one table walks normal -> compact -> cards -> compact -> normal as the room changes, with hysteresis on the way back', () => {
    const room = { value: 1000 };
    const layout = layoutOf(room);
    const { tables } = build(headed(5));
    const table = tables[0]; // 5 x 100 = 500 normal; 5 x 60 = 300 compact
    const modeAt = (value: number) => {
      room.value = value;
      adaptTables([table], { layout });
      return currentMode(table);
    };
    expect(modeAt(1000)).toBe('normal');
    expect(modeAt(450)).toBe('compact'); // no longer fits normally
    expect(modeAt(250)).toBe('cards'); // not even compacted
    expect(modeAt(300)).toBe('cards'); // compact would just fit - but not with slack to spare
    expect(modeAt(300 + HYSTERESIS_PX)).toBe('compact');
    expect(modeAt(500)).toBe('compact'); // normal would just fit - same
    expect(modeAt(500 + HYSTERESIS_PX)).toBe('normal');
  });

  it('removes the chrome and labels again when a table gets room', () => {
    const room = { value: 200 };
    const layout = layoutOf(room);
    const { tables } = build(headed(5));
    adaptTables(tables, { layout });
    expect(currentMode(tables[0])).toBe('cards');
    expect(document.querySelector(`.${ACTIONS_CLASS}`)).not.toBeNull();
    room.value = 2000;
    adaptTables(tables, { layout });
    expect(currentMode(tables[0])).toBe('normal');
    expect(document.querySelector(`.${ACTIONS_CLASS}`)).toBeNull();
    expect(document.querySelector('[data-label]')).toBeNull();
    expect(document.querySelector(`[${HEADER_ROW_ATTRIBUTE}]`)).toBeNull();
    expect(document.querySelectorAll('[data-vach-ui]')).toHaveLength(0);
  });

  it('never leaves the measuring class behind', () => {
    const room = { value: 100 };
    const { tables } = build(headed(5) + headerless(5));
    adaptTables(tables, { layout: layoutOf(room) });
    expect(document.querySelectorAll(`.${MEASURE_CLASS}`)).toHaveLength(0);
  });
});

describe('Expand Grid', () => {
  it('the button hands the table to onExpand and does not bubble (a tap on it is not a tap on the page)', () => {
    const room = { value: 200 };
    const { chapter, tables } = build(headed(5));
    const onExpand = vi.fn();
    const pageTap = vi.fn();
    chapter.addEventListener('click', pageTap);
    adaptTables(tables, { layout: layoutOf(room), onExpand });
    (document.querySelector(`.${EXPAND_BUTTON_CLASS}`) as HTMLButtonElement).click();
    expect(onExpand).toHaveBeenCalledWith(tables[0]);
    expect(pageTap).not.toHaveBeenCalled();
  });

  it('cloneForGrid gives a clean copy: same content, no reader classes, labels or chrome', () => {
    const room = { value: 200 };
    const { tables } = build(headed(5));
    adaptTables(tables, { layout: layoutOf(room) });
    expect(tables[0].querySelector('[data-label]')).not.toBeNull();
    const clone = cloneForGrid(tables[0]);
    expect(clone.querySelector('[data-label]')).toBeNull();
    expect(clone.querySelector(`[${HEADER_ROW_ATTRIBUTE}]`)).toBeNull();
    expect(clone.className).toBe('vach-table-grid');
    expect(clone.getAttribute('data-vach-mode')).toBeNull();
    expect(clone.querySelector(`.${ACTIONS_CLASS}`)).toBeNull();
    expect(clone.textContent).not.toContain(EXPAND_LABEL);
    expect(clone.textContent).toBe(tables[0].textContent!.replace(tables[0].querySelector(`.${ACTIONS_CLASS}`)!.textContent!, ''));
    expect(clone).not.toBe(tables[0]);
  });
});

describe('TableAdaptController', () => {
  it('adapts a registered chapter with tables on the next frame, and ignores chapters without tables', async () => {
    const room = { value: 360 };
    const controller = new TableAdaptController({ layout: layoutOf(room) });
    const { chapter, tables } = build(headed(9));
    const plain = document.createElement('section');
    plain.className = 'chapter';
    plain.innerHTML = '<p>no tables</p>';
    document.body.append(plain);

    controller.register(plain);
    controller.register(chapter);
    await controller.reevaluate();
    expect(currentMode(tables[0])).toBe('cards');
    controller.destroy();
  });

  it('reevaluate() re-decides after the room changes (rotation, font size) and resolves once written', async () => {
    const room = { value: 1000 };
    const controller = new TableAdaptController({ layout: layoutOf(room) });
    const { chapter, tables } = build(headed(5));
    controller.register(chapter);
    await controller.reevaluate();
    expect(currentMode(tables[0])).toBe('normal');

    room.value = 200;
    await controller.reevaluate();
    expect(currentMode(tables[0])).toBe('cards');
    controller.destroy();
  });

  it('wraps each pass in preserveView, unless the caller will restore the position itself', async () => {
    const room = { value: 1000 };
    const preserveView = vi.fn((work: () => void) => work());
    const controller = new TableAdaptController({ layout: layoutOf(room), preserveView });
    const { chapter } = build(headed(2));
    controller.register(chapter);
    await controller.reevaluate();
    const calls = preserveView.mock.calls.length;
    expect(calls).toBeGreaterThan(0);

    await controller.reevaluate({ preserveView: false });
    expect(preserveView.mock.calls.length).toBe(calls);
    controller.destroy();
  });

  it('stops adapting a chapter once it is unregistered', async () => {
    const room = { value: 1000 };
    const controller = new TableAdaptController({ layout: layoutOf(room) });
    const { chapter, tables } = build(headed(5));
    const unregister = controller.register(chapter);
    await controller.reevaluate();
    unregister();
    room.value = 100;
    await controller.reevaluate();
    expect(currentMode(tables[0])).toBe('normal');
    controller.destroy();
  });

  it('only adapts chapters that are in view when an IntersectionObserver exists (far-off chapters wait until they come near)', async () => {
    const observers: Array<{ callback: IntersectionObserverCallback; targets: Element[] }> = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        targets: Element[] = [];
        callback: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
          observers.push(this);
        }
        observe(target: Element) {
          this.targets.push(target);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      const room = { value: 200 };
      const controller = new TableAdaptController({ layout: layoutOf(room) });
      document.body.innerHTML =
        `<section class="chapter" id="near">${headed(5)}</section><section class="chapter" id="far">${headed(5)}</section>`;
      const near = document.getElementById('near')!;
      const far = document.getElementById('far')!;
      controller.register(near);
      controller.register(far);
      await controller.reevaluate();
      // Nothing intersects yet: nothing was measured.
      expect(currentMode(near.querySelector('table')!)).toBeNull();
      expect(currentMode(far.querySelector('table')!)).toBeNull();

      observers[0].callback([{ target: near, isIntersecting: true } as unknown as IntersectionObserverEntry], observers[0] as unknown as IntersectionObserver);
      await controller.reevaluate();
      expect(currentMode(near.querySelector('table')!)).toBe('cards');
      expect(currentMode(far.querySelector('table')!)).toBeNull(); // still off-screen: untouched

      // It comes into view later: adapted then, with whatever the room is by now.
      room.value = 2000;
      observers[0].callback([{ target: far, isIntersecting: true } as unknown as IntersectionObserverEntry], observers[0] as unknown as IntersectionObserver);
      await controller.reevaluate();
      expect(currentMode(far.querySelector('table')!)).toBe('normal');
      controller.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('watchWidth', () => {
  it('calls back (debounced) when the width changes, and ignores height-only changes', () => {
    vi.useFakeTimers();
    let callback: ResizeObserverCallback = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          callback = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      const element = document.createElement('div');
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ width: 400 } as DOMRect);
      const onChange = vi.fn();
      const stop = watchWidth(element, onChange, 100);
      const fire = (width: number) => callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);

      fire(400); // same width (a height-only change reports the same width)
      vi.advanceTimersByTime(500);
      expect(onChange).not.toHaveBeenCalled();

      fire(300);
      fire(250);
      fire(210); // a burst while rotating
      vi.advanceTimersByTime(99);
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(onChange).toHaveBeenCalledTimes(1);

      stop();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
