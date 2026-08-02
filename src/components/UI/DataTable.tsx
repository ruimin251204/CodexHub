import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { mergeClassNames } from "./classNames";

export type DataTableSortDirection = "asc" | "desc";
export type DataTableColumnPriority = "essential" | "normal" | "optional";

export interface DataTableSort {
  columnId: string;
  direction: DataTableSortDirection;
}

export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  sortable?: boolean;
  align?: "start" | "center" | "end";
  priority?: DataTableColumnPriority;
  headerClassName?: string;
  cellClassName?: string;
}

export interface DataTableSelection<Row> {
  selectedKeys: ReadonlySet<string>;
  onSelectedKeysChange: (keys: Set<string>) => void;
  getRowLabel: (row: Row) => string;
  selectAllLabel: string;
}

export interface DataTableProps<Row> {
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row) => string;
  ariaLabel: string;
  caption?: ReactNode;
  sort?: DataTableSort;
  onSortChange?: (sort: DataTableSort) => void;
  selection?: DataTableSelection<Row>;
  emptyState?: ReactNode;
  loading?: boolean;
  loadingLabel?: ReactNode;
  onRowActivate?: (row: Row) => void;
  getRowClassName?: (row: Row) => string | undefined;
  className?: string;
}

interface SelectionCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

function SelectionCheckbox({
  checked,
  indeterminate = false,
  label,
  onChange
}: SelectionCheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      ref={inputRef}
      className="ch-data-table__checkbox"
      type="checkbox"
      checked={checked}
      aria-label={label}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}

export function DataTable<Row>({
  columns,
  rows,
  getRowKey,
  ariaLabel,
  caption,
  sort,
  onSortChange,
  selection,
  emptyState,
  loading = false,
  loadingLabel,
  onRowActivate,
  getRowClassName,
  className
}: DataTableProps<Row>) {
  const rowKeys = rows.map(getRowKey);
  const selectedOnPage = selection
    ? rowKeys.filter((key) => selection.selectedKeys.has(key)).length
    : 0;
  const allSelected = rows.length > 0 && selectedOnPage === rows.length;
  const someSelected = selectedOnPage > 0 && !allSelected;
  const columnCount = columns.length + (selection ? 1 : 0);

  function updatePageSelection(checked: boolean) {
    if (!selection) {
      return;
    }
    const next = new Set(selection.selectedKeys);
    rowKeys.forEach((key) => {
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
    });
    selection.onSelectedKeysChange(next);
  }

  function updateRowSelection(key: string, checked: boolean) {
    if (!selection) {
      return;
    }
    const next = new Set(selection.selectedKeys);
    if (checked) {
      next.add(key);
    } else {
      next.delete(key);
    }
    selection.onSelectedKeysChange(next);
  }

  function activateFromKeyboard(event: KeyboardEvent<HTMLTableRowElement>, row: Row) {
    if (!onRowActivate || event.target !== event.currentTarget) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRowActivate(row);
    }
  }

  return (
    <div className={mergeClassNames("ch-data-table", className)} data-loading={loading || undefined}>
      <div className="ch-data-table__scroller">
        <table aria-label={ariaLabel}>
          {caption ? <caption>{caption}</caption> : null}
          <thead>
            <tr>
              {selection ? (
                <th className="ch-data-table__selection-cell" scope="col">
                  <SelectionCheckbox
                    checked={allSelected}
                    indeterminate={someSelected}
                    label={selection.selectAllLabel}
                    onChange={updatePageSelection}
                  />
                </th>
              ) : null}
              {columns.map((column) => {
                const activeSort = sort?.columnId === column.id ? sort.direction : undefined;
                return (
                  <th
                    key={column.id}
                    className={column.headerClassName}
                    scope="col"
                    data-align={column.align ?? "start"}
                    data-priority={column.priority ?? "normal"}
                    aria-sort={activeSort ? (activeSort === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {column.sortable && onSortChange ? (
                      <button
                        className="ch-data-table__sort"
                        type="button"
                        data-active={Boolean(activeSort) || undefined}
                        onClick={() => onSortChange({
                          columnId: column.id,
                          direction: activeSort === "asc" ? "desc" : "asc"
                        })}
                      >
                        <span>{column.header}</span>
                        <span className="ch-data-table__sort-icon" aria-hidden="true">
                          {activeSort === "asc" ? "↑" : activeSort === "desc" ? "↓" : "↕"}
                        </span>
                      </button>
                    ) : column.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="ch-data-table__message" colSpan={columnCount}>
                  <span className="ch-data-table__spinner" aria-hidden="true" />
                  {loadingLabel}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="ch-data-table__message" colSpan={columnCount}>{emptyState}</td>
              </tr>
            ) : rows.map((row) => {
              const key = getRowKey(row);
              const selected = selection?.selectedKeys.has(key) ?? false;
              return (
                <tr
                  key={key}
                  className={getRowClassName?.(row)}
                  data-selected={selected || undefined}
                  data-interactive={Boolean(onRowActivate) || undefined}
                  tabIndex={onRowActivate ? 0 : undefined}
                  onClick={onRowActivate ? () => onRowActivate(row) : undefined}
                  onKeyDown={onRowActivate ? (event) => activateFromKeyboard(event, row) : undefined}
                >
                  {selection ? (
                    <td className="ch-data-table__selection-cell">
                      <SelectionCheckbox
                        checked={selected}
                        label={selection.getRowLabel(row)}
                        onChange={(checked) => updateRowSelection(key, checked)}
                      />
                    </td>
                  ) : null}
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={column.cellClassName}
                      data-align={column.align ?? "start"}
                      data-priority={column.priority ?? "normal"}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
