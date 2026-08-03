import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from "react";
import type { WorkspaceCopy } from "../copy";
import type { WorkspaceLocale, WorkspaceTransfer } from "../types";
import { transferUiCopy } from "../transfers/copy";
import { formatBytes, progressValue } from "../transfers/format";
import { usePersonalInfoMasking } from "../../ui/PersonalInfoMasking";
import { FilesIcon } from "./FilesIcon";
import type { FilesUiCopy } from "./filesUiCopy";

const ACTIVE_STATES = new Set<WorkspaceTransfer["state"]>([
  "queued", "running", "pausing", "paused", "waiting-conflict", "verifying", "finalizing"
]);
const TRANSFER_DRAWER_MIN_HEIGHT = 112;
const TRANSFER_DRAWER_DEFAULT_HEIGHT = 210;
const TRANSFER_DRAWER_DEFAULT_MAX_HEIGHT = 420;

function clampDrawerHeight(height: number, maximum: number) {
  return Math.min(maximum, Math.max(TRANSFER_DRAWER_MIN_HEIGHT, Math.round(height)));
}

export function FileTransferDrawer({
  collapsed,
  copy,
  displayNames,
  locale,
  transfers,
  ui,
  onCancel,
  onPause,
  onResume,
  onToggle
}: {
  collapsed: boolean;
  copy: WorkspaceCopy;
  displayNames: ReadonlyMap<string, string>;
  locale: WorkspaceLocale;
  transfers: WorkspaceTransfer[];
  ui: FilesUiCopy;
  onCancel: (transfer: WorkspaceTransfer) => void;
  onPause: (transfer: WorkspaceTransfer) => void;
  onResume: (transfer: WorkspaceTransfer) => void;
  onToggle: () => void;
}) {
  const personalInfo = usePersonalInfoMasking();
  const transferCopy = transferUiCopy[locale];
  const drawerRef = useRef<HTMLElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [drawerHeight, setDrawerHeight] = useState(TRANSFER_DRAWER_DEFAULT_HEIGHT);
  const [drawerMaxHeight, setDrawerMaxHeight] = useState(TRANSFER_DRAWER_DEFAULT_MAX_HEIGHT);
  const activeCount = transfers.filter((transfer) => ACTIVE_STATES.has(transfer.state)).length;
  const completedCount = transfers.filter((transfer) => transfer.state === "completed").length;
  const aggregateSpeed = transfers.reduce(
    (total, transfer) => total + Number(transfer.speedBytesPerSecond ?? 0),
    0
  );

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const availableMaximum = () => {
    const containerHeight = drawerRef.current?.parentElement?.clientHeight ?? 0;
    return containerHeight > 0
      ? Math.max(
          TRANSFER_DRAWER_MIN_HEIGHT,
          Math.min(Math.floor(containerHeight * 0.7), containerHeight - 160)
        )
      : TRANSFER_DRAWER_DEFAULT_MAX_HEIGHT;
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || collapsed) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    const maximum = availableMaximum();
    const initialY = event.clientY;
    const measuredHeight = drawerRef.current?.getBoundingClientRect().height ?? 0;
    const initialHeight = measuredHeight > 0 ? measuredHeight : drawerHeight;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const move = (pointerEvent: PointerEvent) => {
      setDrawerHeight(clampDrawerHeight(initialHeight + initialY - pointerEvent.clientY, maximum));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      resizeCleanupRef.current = null;
    };

    setDrawerMaxHeight(maximum);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    resizeCleanupRef.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const maximum = availableMaximum();
    const step = event.shiftKey ? 48 : 16;
    const next = event.key === "ArrowUp"
      ? drawerHeight + step
      : event.key === "ArrowDown"
        ? drawerHeight - step
        : event.key === "Home"
          ? TRANSFER_DRAWER_MIN_HEIGHT
          : event.key === "End"
            ? maximum
            : null;
    if (next === null) return;
    event.preventDefault();
    setDrawerMaxHeight(maximum);
    setDrawerHeight(clampDrawerHeight(next, maximum));
  };

  if (transfers.length === 0) return null;

  return (
    <section
      aria-label={ui.transferQueue}
      className="workspaceFileTransferDrawer"
      data-collapsed={collapsed}
      ref={drawerRef}
      style={{ "--workspace-file-transfer-height": `${drawerHeight}px` } as CSSProperties}
    >
      {!collapsed ? (
        <button
          aria-label={ui.resizeTransfers}
          aria-orientation="horizontal"
          aria-valuemax={drawerMaxHeight}
          aria-valuemin={TRANSFER_DRAWER_MIN_HEIGHT}
          aria-valuenow={drawerHeight}
          className="workspaceFileTransferResizeHandle"
          role="separator"
          type="button"
          onKeyDown={resizeWithKeyboard}
          onPointerDown={startResize}
        />
      ) : null}
      <header>
        <div>
          <span className="workspaceFileTransferTitle"><FilesIcon name="transfer" />{ui.transferQueue}</span>
          <span className="workspaceFileTransferSummary">
            {activeCount} {ui.activeTransfers}
            {completedCount > 0 ? ` · ${completedCount} ${ui.completedTransfers}` : ""}
            {aggregateSpeed > 0 ? ` · ${formatBytes(String(aggregateSpeed))}/s` : ""}
          </span>
        </div>
        <button
          aria-expanded={!collapsed}
          aria-label={collapsed ? ui.expandTransfers : ui.collapseTransfers}
          title={collapsed ? ui.expandTransfers : ui.collapseTransfers}
          type="button"
          onClick={onToggle}
        >
          <FilesIcon name={collapsed ? "chevronUp" : "chevronDown"} />
        </button>
      </header>
      {!collapsed ? (
        <div className="workspaceFileTransferTable" role="table" aria-label={ui.transferQueue}>
          <div className="workspaceFileTransferHeader" role="row">
            <span role="columnheader">{ui.transferFile}</span>
            <span role="columnheader">{ui.transferTarget}</span>
            <span role="columnheader">{ui.transferProgress}</span>
            <span role="columnheader">{ui.transferSpeed}</span>
            <span role="columnheader">{ui.transferStatus}</span>
            <span role="columnheader"><span className="workspaceVisuallyHidden">{copy.actions}</span></span>
          </div>
          <div className="workspaceFileTransferRows" role="rowgroup">
            {transfers.map((transfer) => {
              const progress = progressValue(transfer);
              const displayName = displayNames.get(transfer.transferId) ?? transfer.sourceLabel;
              return (
                <div className="workspaceFileTransferRow" data-state={transfer.state} key={transfer.transferId} role="row">
                  <span className="workspaceFileTransferName" role="cell" title={personalInfo.maskText(displayName)}>
                    <FilesIcon name={transfer.direction === "upload" ? "upload" : "download"} />
                    <span>{personalInfo.maskText(displayName)}</span>
                  </span>
                  <span role="cell" title={personalInfo.maskText(transfer.targetLabel)}>{personalInfo.maskText(transfer.targetLabel)}</span>
                  <span className="workspaceFileTransferProgress" role="cell">
                    <span>{progress === null ? "—" : `${progress.toFixed(0)}%`}</span>
                    <progress aria-label={ui.transferProgress} max={100} value={progress ?? undefined} />
                  </span>
                  <span role="cell">{transfer.speedBytesPerSecond ? `${formatBytes(transfer.speedBytesPerSecond)}/s` : "—"}</span>
                  <span role="cell"><i aria-hidden="true" />{transferCopy.status[transfer.state]}</span>
                  <span className="workspaceFileTransferActions" role="cell">
                    {transfer.capabilities.canPause ? <button aria-label={copy.pause} title={copy.pause} type="button" onClick={() => onPause(transfer)}>Ⅱ</button> : null}
                    {transfer.capabilities.canResume ? <button aria-label={copy.resume} title={copy.resume} type="button" onClick={() => onResume(transfer)}>▶</button> : null}
                    {transfer.capabilities.canCancel ? <button aria-label={copy.cancelTransfer} title={copy.cancelTransfer} type="button" onClick={() => onCancel(transfer)}>×</button> : null}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
