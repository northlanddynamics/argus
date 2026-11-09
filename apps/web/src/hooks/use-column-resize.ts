import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";

/** The narrowest a dragged column can go, in px. */
const MIN_COLUMN = 40;
/** The narrowest the flexible column (the row's subject) can be squeezed to before the table scrolls. */
const MIN_FLEX = 160;

export type ColumnResizer = {
  /** Starts dragging the right edge of `head`'s column. */
  start: (event: React.PointerEvent<HTMLElement>, head: HTMLTableCellElement) => void;
  /** Puts `head`'s column back to the width the table's CSS gives it. */
  reset: (head: HTMLTableCellElement) => void;
  /** A header cell mounted or unmounted, so the handles and widths are laid out again. */
  changed: () => void;
};

/** Where a cell starts, counting the columns spanned by the cells before it. */
function columnOf(cell: HTMLTableCellElement) {
  let index = 0;
  for (let prev = cell.previousElementSibling; prev; prev = prev.previousElementSibling) {
    index += (prev as HTMLTableCellElement).colSpan;
  }
  return index;
}

/**
 * Drag-to-resize columns for a table. Until a column is dragged the table's own CSS (its
 * `colgroup` and container queries) decides every width. Once one is, the table switches to a
 * fixed layout: dragged columns keep the share of the table they were given (never below
 * MIN_COLUMN), the others hold the width the CSS gives them, columns the CSS has collapsed stay
 * collapsed, and one flexible column (the row's subject, or the widest column of a table without a
 * `colgroup`; the last column once the subject has been dragged too) takes up the slack, so the
 * table still fills its card and only scrolls once the columns no longer fit. Widths are applied straight to the DOM and laid out again
 * whenever the table's container changes size. They last until the page is left.
 */
export function useColumnResize(tableRef: RefObject<HTMLTableElement | null>): ColumnResizer {
  // Dragged widths by column index, as a share of the table's container so they grow and shrink
  // with the screen, valid for as long as the table has `count` columns.
  const user = useRef({ widths: new Map<number, number>(), count: 0 });
  const frame = useRef(0);

  const layout = useCallback(() => {
    const table = tableRef.current;
    if (!table) return;
    const cols = [...(table.querySelector(":scope > colgroup")?.children ?? [])] as HTMLTableColElement[];
    const headRow = table.tHead?.rows[0];
    const heads = [...(headRow?.cells ?? [])];
    const count = cols.length || heads.reduce((sum, cell) => sum + cell.colSpan, 0);

    // Back to what the CSS alone says, then measure that.
    table.style.tableLayout = table.style.width = table.style.minWidth = "";
    for (const col of cols) col.style.width = "";
    for (const head of heads) head.style.width = "";

    const state = user.current;
    if (state.count !== count) {
      state.widths.clear();
      state.count = count;
    }

    // A handle only where its column can be seen and is a single column.
    for (const head of heads) {
      head.toggleAttribute("data-resize-hidden", head.colSpan > 1 || head.getBoundingClientRect().width < 12);
    }
    if (state.widths.size === 0) return;
    const room = table.parentElement?.clientWidth ?? table.getBoundingClientRect().width;
    const dragged = (i: number) => {
      const share = state.widths.get(i);
      return share === undefined ? undefined : Math.max(MIN_COLUMN, Math.round(share * room));
    };

    // Each column's width as laid out, from the first row with a cell per column.
    const row = [...table.rows].find((r) => r.cells.length === count && [...r.cells].every((c) => c.colSpan === 1));
    if (!row) return;
    const natural = [...row.cells].map((cell) => cell.getBoundingClientRect().width);

    // Which columns the CSS leaves to `auto`. A laid-out `col` reports its used width, so read
    // the specified ones while the table is briefly out of layout (nothing paints in between).
    let specified: string[] = [];
    if (cols.length) {
      table.style.display = "none";
      specified = cols.map((col) => getComputedStyle(col).width);
      table.style.display = "";
    }

    // The flexible column: one the CSS leaves to `auto`, the widest if several are.
    let flex = -1;
    natural.forEach((width, i) => {
      if (width === 0 || state.widths.has(i)) return;
      if (cols.length && specified[i] !== "auto") return;
      if (flex < 0 || width > natural[flex]) flex = i;
    });
    // With none left (the subject itself was dragged), the last column takes the slack, so the
    // rows still reach the card's edge.
    if (flex < 0) {
      flex = natural.findLastIndex((width) => width > 0);
    }

    const target = (i: number) => cols[i] ?? heads.find((head) => columnOf(head) === i);
    let fixed = 0;
    natural.forEach((width, i) => {
      if (width === 0) return;
      const el = target(i);
      if (i === flex) {
        if (el) el.style.width = "auto";
        return;
      }
      const w = dragged(i) ?? width;
      if (el) el.style.width = `${w}px`;
      fixed += w;
    });
    table.style.tableLayout = "fixed";
    // The flexible column keeps a width it was dragged to as its least, else up to MIN_FLEX.
    const least = flex < 0 ? 0 : (dragged(flex) ?? Math.min(MIN_FLEX, natural[flex]));
    table.style.minWidth = `${fixed + least}px`;
  }, [tableRef]);

  useLayoutEffect(() => {
    const container = tableRef.current?.parentElement;
    if (!container) return;
    layout();
    const observer = new ResizeObserver(() => layout());
    observer.observe(container);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [tableRef, layout]);

  const changed = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(layout);
  }, [layout]);

  const start = useCallback<ColumnResizer["start"]>(
    (event, head) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      const index = columnOf(head);
      const startX = event.clientX;
      const startWidth = head.getBoundingClientRect().width;
      const root = document.documentElement;
      handle.setPointerCapture(event.pointerId);
      handle.dataset.resizing = "";
      root.style.cursor = "col-resize";
      root.style.userSelect = "none";

      const move = (e: PointerEvent) => {
        const room = head.closest("table")?.parentElement?.clientWidth || 1;
        user.current.widths.set(index, Math.max(MIN_COLUMN, startWidth + e.clientX - startX) / room);
        layout();
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        delete handle.dataset.resizing;
        root.style.cursor = root.style.userSelect = "";
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    },
    [layout],
  );

  const reset = useCallback<ColumnResizer["reset"]>(
    (head) => {
      user.current.widths.delete(columnOf(head));
      layout();
    },
    [layout],
  );

  return useMemo(() => ({ start, reset, changed }), [start, reset, changed]);
}
