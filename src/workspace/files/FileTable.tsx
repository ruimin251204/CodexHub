import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { WorkspaceCopy } from "../copy";
import type { RemoteFileEntry, WorkspaceFileOperationKind, WorkspaceFileSortField } from "../types";
import { displaySize, formatModifiedAt } from "./fileDisplay";
import { FileGlyph } from "./FileGlyph";
import type { FilesUiCopy } from "./filesUiCopy";
import { usePersonalInfoMasking } from "../../ui/PersonalInfoMasking";

type ContextPoint = { x: number; y: number };
type ResizableColumn = "name" | "size" | "modified";
type FileColumnWidths = Record<ResizableColumn, number>;

const FILE_GRID_OVERHEAD = 48;

const COLUMN_LIMITS: Record<ResizableColumn, { min: number; max: number }> = {
  name: { min: 200, max: 920 },
  size: { min: 88, max: 320 },
  modified: { min: 154, max: 420 }
};

const DEFAULT_COLUMN_WIDTHS: FileColumnWidths = {
  name: 340,
  size: 124,
  modified: 188
};

const STANDARD_COLUMN_MINIMUMS: FileColumnWidths = {
  name: 160,
  size: 72,
  modified: 116
};

const COMPACT_COLUMN_MINIMUMS: FileColumnWidths = {
  name: 88,
  size: 52,
  modified: 84
};

function clampColumnWidth(column: ResizableColumn, width: number) {
  const { min, max } = COLUMN_LIMITS[column];
  return Math.max(min, Math.min(max, Math.round(width)));
}

function distributeColumnWidths(name: number, size: number, available: number): FileColumnWidths {
  const resolvedName = Math.max(0, Math.floor(name));
  const resolvedSize = Math.max(0, Math.floor(size));
  return {
    name: resolvedName,
    size: resolvedSize,
    modified: Math.max(0, Math.floor(available - resolvedName - resolvedSize))
  };
}

/** Fits a user's preferred column widths into the live list viewport without horizontal scrolling. */
export function resolveFileColumnWidths(
  preferred: FileColumnWidths,
  containerWidth: number,
  compact = false
): FileColumnWidths {
  if (containerWidth <= 0) return preferred;

  const available = Math.max(0, containerWidth - FILE_GRID_OVERHEAD);
  const preferredTotal = preferred.name + preferred.size + preferred.modified;
  if (available >= preferredTotal) {
    return { ...preferred, name: preferred.name + available - preferredTotal };
  }

  const minimums = compact ? COMPACT_COLUMN_MINIMUMS : STANDARD_COLUMN_MINIMUMS;
  const minimumTotal = minimums.name + minimums.size + minimums.modified;
  if (available <= minimumTotal) {
    const ratio = available / minimumTotal;
    return distributeColumnWidths(minimums.name * ratio, minimums.size * ratio, available);
  }

  const preferredFlex = {
    name: Math.max(0, preferred.name - minimums.name),
    size: Math.max(0, preferred.size - minimums.size),
    modified: Math.max(0, preferred.modified - minimums.modified)
  };
  const preferredFlexTotal = preferredFlex.name + preferredFlex.size + preferredFlex.modified;
  if (preferredFlexTotal === 0) return distributeColumnWidths(minimums.name, minimums.size, available);

  const remaining = available - minimumTotal;
  return distributeColumnWidths(
    minimums.name + remaining * (preferredFlex.name / preferredFlexTotal),
    minimums.size + remaining * (preferredFlex.size / preferredFlexTotal),
    available
  );
}

function ResizableColumnHeader({
  ariaSort,
  column,
  label,
  resizeLabel,
  width,
  onResizeKeyDown,
  onResizeStart
}: {
  ariaSort: "ascending" | "descending" | "none";
  column: ResizableColumn;
  label: string;
  resizeLabel: string;
  width: number;
  onResizeKeyDown: (column: ResizableColumn, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onResizeStart: (column: ResizableColumn, event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const limits = COLUMN_LIMITS[column];
  return (
    <span aria-label={label} aria-sort={ariaSort} className="workspaceFileColumnHeader" role="columnheader">
      <span>{label}</span>
      <button
        aria-label={`${resizeLabel}: ${label}`}
        aria-orientation="vertical"
        aria-valuemax={limits.max}
        aria-valuemin={limits.min}
        aria-valuenow={width}
        className="workspaceFileColumnResizeHandle"
        role="separator"
        type="button"
        onKeyDown={(event) => onResizeKeyDown(column, event)}
        onPointerDown={(event) => onResizeStart(column, event)}
      />
    </span>
  );
}

export function FileTable({
  compact = false,
  copy,
  entries,
  focusedIndex,
  locale,
  selectedRefs,
  sortAscending,
  sortKey,
  ui,
  onAskOperation,
  onContextMenu,
  onFocusedIndexChange,
  onMove,
  onOpenEntry,
  onSelectEntry,
  onSelectPage,
  onShowPreview
}: {
  compact?: boolean;
  copy: WorkspaceCopy;
  entries: RemoteFileEntry[];
  focusedIndex: number;
  locale: "en" | "zh";
  selectedRefs: ReadonlySet<string>;
  sortAscending: boolean;
  sortKey: WorkspaceFileSortField;
  ui: FilesUiCopy;
  onAskOperation: (operation: WorkspaceFileOperationKind, entry: RemoteFileEntry, destinationPath?: string | null) => void;
  onContextMenu: (entry: RemoteFileEntry, point: ContextPoint) => void;
  onFocusedIndexChange: (index: number) => void;
  onMove: (source: RemoteFileEntry, destination: RemoteFileEntry) => void;
  onOpenEntry: (entry: RemoteFileEntry) => void;
  onSelectEntry: (entry: RemoteFileEntry, toggle: boolean) => void;
  onSelectPage: (selected: boolean) => void;
  onShowPreview: (entry: RemoteFileEntry) => void;
}) {
  const personalInfo = usePersonalInfoMasking();
  const gridRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [columnWidths, setColumnWidths] = useState(DEFAULT_COLUMN_WIDTHS);
  const [containerWidth, setContainerWidth] = useState(0);
  const [resizingColumn, setResizingColumn] = useState<ResizableColumn | null>(null);
  const allSelected = entries.length > 0 && entries.every((entry) => selectedRefs.has(entry.entryRef));

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => setContainerWidth(grid.clientWidth);
    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  // Keep column preferences in the table so selection, filtering and pagination remain independent of sizing.
  const startColumnResize = (column: ResizableColumn, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();

    const initialX = event.clientX;
    const initialWidth = columnWidths[column];
    const move = (pointerEvent: PointerEvent) => {
      setColumnWidths((current) => ({
        ...current,
        [column]: clampColumnWidth(column, initialWidth + pointerEvent.clientX - initialX)
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      resizeCleanupRef.current = null;
      setResizingColumn(null);
    };

    resizeCleanupRef.current = stop;
    setResizingColumn(column);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const handleColumnResizeKeyDown = (column: ResizableColumn, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const delta = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    if (!delta) return;
    event.preventDefault();
    setColumnWidths((current) => ({
      ...current,
      [column]: clampColumnWidth(column, current[column] + delta)
    }));
  };

  const resolvedColumnWidths = useMemo(
    () => resolveFileColumnWidths(columnWidths, containerWidth, compact),
    [columnWidths, compact, containerWidth]
  );

  const gridStyle = {
    "--workspace-file-name-column-width": `${resolvedColumnWidths.name}px`,
    "--workspace-file-size-column-width": `${resolvedColumnWidths.size}px`,
    "--workspace-file-modified-column-width": `${resolvedColumnWidths.modified}px`
  } as CSSProperties;

  const focusRow = (index: number) => {
    const bounded = Math.max(0, Math.min(entries.length - 1, index));
    onFocusedIndexChange(bounded);
    rowRefs.current.get(entries[bounded]?.entryRef ?? "")?.focus();
  };

  const handleGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, entry: RemoteFileEntry, index: number) => {
    if (event.key === "ArrowDown") { event.preventDefault(); focusRow(index + 1); }
    if (event.key === "ArrowUp") { event.preventDefault(); focusRow(index - 1); }
    if (event.key === "Home") { event.preventDefault(); focusRow(0); }
    if (event.key === "End") { event.preventDefault(); focusRow(entries.length - 1); }
    if (event.key === "Enter") { event.preventDefault(); onOpenEntry(entry); }
    if (event.key === " ") { event.preventDefault(); onShowPreview(entry); }
    if (event.key === "F2" && entry.writable) { event.preventDefault(); onAskOperation("rename", entry); }
    if (event.key === "Delete" && entry.writable) { event.preventDefault(); onAskOperation("delete", entry); }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onContextMenu(entry, { x: rect.left + 24, y: rect.top + 24 });
    }
  };

  const selectRow = (event: ReactMouseEvent, entry: RemoteFileEntry, index: number) => {
    onFocusedIndexChange(index);
    onSelectEntry(entry, event.ctrlKey || event.metaKey);
  };

  return (
    <div
      className="workspaceFileGrid"
      data-resizing-column={resizingColumn ?? undefined}
      ref={gridRef}
      role="grid"
      aria-label={ui.tableView}
      style={gridStyle}
    >
      <div className="workspaceFileGridHeader" role="row">
        <span className="workspaceFileCheckboxCell" role="columnheader">
          <input
            aria-label={allSelected ? ui.clearPageSelection : ui.selectAllPage}
            checked={allSelected}
            type="checkbox"
            onChange={(event) => onSelectPage(event.target.checked)}
          />
        </span>
        <ResizableColumnHeader
          ariaSort={sortKey === "name" ? sortAscending ? "ascending" : "descending" : "none"}
          column="name"
          label={copy.fileName}
          resizeLabel={ui.resizeColumn}
          width={columnWidths.name}
          onResizeKeyDown={handleColumnResizeKeyDown}
          onResizeStart={startColumnResize}
        />
        <ResizableColumnHeader
          ariaSort={sortKey === "size" ? sortAscending ? "ascending" : "descending" : "none"}
          column="size"
          label={copy.fileSize}
          resizeLabel={ui.resizeColumn}
          width={columnWidths.size}
          onResizeKeyDown={handleColumnResizeKeyDown}
          onResizeStart={startColumnResize}
        />
        <ResizableColumnHeader
          ariaSort={sortKey === "modified" ? sortAscending ? "ascending" : "descending" : "none"}
          column="modified"
          label={copy.fileModified}
          resizeLabel={ui.resizeColumn}
          width={columnWidths.modified}
          onResizeKeyDown={handleColumnResizeKeyDown}
          onResizeStart={startColumnResize}
        />
      </div>
      <div className="workspaceFileGridBody" role="rowgroup">
        {entries.map((entry, index) => (
          <div
            aria-selected={selectedRefs.has(entry.entryRef)}
            className="workspaceFileRow"
            data-kind={entry.kind}
            draggable={entry.writable && entry.nameEncoding === "utf8"}
            key={entry.entryRef}
            ref={(node) => { if (node) rowRefs.current.set(entry.entryRef, node); else rowRefs.current.delete(entry.entryRef); }}
            role="row"
            tabIndex={focusedIndex === index ? 0 : -1}
            onClick={(event) => selectRow(event, entry, index)}
            onContextMenu={(event) => {
              event.preventDefault();
              onSelectEntry(entry, false);
              onContextMenu(entry, { x: event.clientX, y: event.clientY });
            }}
            onDoubleClick={() => onOpenEntry(entry)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-codexhub-remote-entry-ref", entry.entryRef);
            }}
            onDragOver={(event) => { if (entry.kind === "directory") event.preventDefault(); }}
            onDrop={(event) => {
              if (entry.kind !== "directory") return;
              const sourceRef = event.dataTransfer.getData("application/x-codexhub-remote-entry-ref");
              const source = entries.find((candidate) => candidate.entryRef === sourceRef);
              if (source && source.entryRef !== entry.entryRef) {
                event.preventDefault();
                onMove(source, entry);
              }
            }}
            onKeyDown={(event) => handleGridKeyDown(event, entry, index)}
          >
            <span className="workspaceFileCheckboxCell" role="gridcell">
              <input
                aria-label={`${ui.selectEntry}: ${personalInfo.maskText(entry.name)}`}
                checked={selectedRefs.has(entry.entryRef)}
                type="checkbox"
                onClick={(event) => event.stopPropagation()}
                onChange={() => onSelectEntry(entry, true)}
              />
            </span>
            <span className="workspaceFileName" role="gridcell" title={personalInfo.maskText(entry.canonicalPath)}><FileGlyph kind={entry.kind} /><span>{personalInfo.maskText(entry.name)}</span></span>
            <span role="gridcell">{entry.kind === "directory" ? "—" : displaySize(entry.size)}</span>
            <span role="gridcell">{formatModifiedAt(entry.modifiedAt, locale === "zh" ? "zh-CN" : "en")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
