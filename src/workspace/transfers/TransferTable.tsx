import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceCopy } from "../copy";
import type { WorkspaceTransfer, WorkspaceTransferDirection } from "../types";
import type { TransferUiCopy } from "./copy";
import { formatBytes, progressValue } from "./format";
import { usePersonalInfoMasking } from "../../ui/PersonalInfoMasking";

type DirectionFilter = "all" | WorkspaceTransferDirection;
type StatusFilter = "all" | "active" | "completed" | "failed";

const ACTIVE_STATES = new Set(["queued", "running", "pausing", "paused", "waiting-conflict", "verifying", "finalizing"]);
const FAILED_STATES = new Set(["failed", "cancelled", "interrupted"]);

function matchesStatus(transfer: WorkspaceTransfer, filter: StatusFilter) {
  if (filter === "all") return true;
  if (filter === "active") return ACTIVE_STATES.has(transfer.state);
  if (filter === "completed") return transfer.state === "completed";
  return FAILED_STATES.has(transfer.state);
}

export function TransferTable({
  busyId,
  copy,
  onCancel,
  onOpenTask,
  onPause,
  onResolveConflict,
  onResume,
  transfers,
  ui
}: {
  busyId: string | null;
  copy: WorkspaceCopy;
  onCancel: (transfer: WorkspaceTransfer) => void;
  onOpenTask?: (taskId: string) => void;
  onPause: (transfer: WorkspaceTransfer) => void;
  onResolveConflict: (transfer: WorkspaceTransfer) => void;
  onResume: (transfer: WorkspaceTransfer, restart: boolean) => void;
  transfers: WorkspaceTransfer[];
  ui: TransferUiCopy;
}) {
  const personalInfo = usePersonalInfoMasking();
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const moreActionsRef = useRef(new Map<string, HTMLDetailsElement>());

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return [...transfers]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((transfer) => direction === "all" || transfer.direction === direction)
      .filter((transfer) => matchesStatus(transfer, status))
      .filter((transfer) => !normalized || [transfer.sourceLabel, transfer.targetLabel, transfer.hostAlias]
        .some((value) => value.toLocaleLowerCase().includes(normalized)));
  }, [direction, query, status, transfers]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => setPage(1), [direction, pageSize, query, status]);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);
  useEffect(() => {
    const closeMoreActions = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      for (const menu of moreActionsRef.current.values()) {
        if (menu.open && !menu.contains(target)) menu.open = false;
      }
    };
    const closeMoreActionsOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const openMenu = Array.from(moreActionsRef.current.values()).find((menu) => menu.open);
      if (!openMenu) return;
      event.preventDefault();
      openMenu.open = false;
      openMenu.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeMoreActions);
    document.addEventListener("keydown", closeMoreActionsOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMoreActions);
      document.removeEventListener("keydown", closeMoreActionsOnEscape);
    };
  }, []);

  const directionTabs: Array<{ value: DirectionFilter; label: string }> = [
    { value: "all", label: ui.allDirections },
    { value: "upload", label: ui.uploads },
    { value: "download", label: ui.downloads }
  ];
  const statusTabs: Array<{ value: StatusFilter; label: string }> = [
    { value: "all", label: ui.allStatuses },
    { value: "active", label: ui.active },
    { value: "completed", label: ui.completed },
    { value: "failed", label: copy.failed }
  ];

  return (
    <section className="transferTableCard">
      <div className="transferFilters">
        <div className="transferDirectionTabs" role="tablist" aria-label={ui.title}>
          {directionTabs.map((tab) => (
            <button aria-selected={direction === tab.value} key={tab.value} role="tab" type="button" onClick={() => setDirection(tab.value)}>
              {tab.label}
            </button>
          ))}
        </div>
        <div className="transferFilterTools">
          <label className="transferSearch">
            <span aria-hidden="true">⌕</span>
            <span className="srOnly">{ui.searchPlaceholder}</span>
            <input value={query} type="search" placeholder={ui.searchPlaceholder} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="transferStatusFilters" aria-label={copy.status}>
            {statusTabs.map((tab) => (
              <button aria-pressed={status === tab.value} key={tab.value} type="button" onClick={() => setStatus(tab.value)}>{tab.label}</button>
            ))}
          </div>
          {(direction !== "all" || status !== "all" || query) ? (
            <button className="transferClearFilter" type="button" onClick={() => { setDirection("all"); setStatus("all"); setQuery(""); }}>{ui.clearFilters}</button>
          ) : null}
        </div>
      </div>

      <div className="transferTableScroller">
        <table className="transferTable">
          <thead>
            <tr>
              <th>{copy.source}</th>
              <th>{copy.destination}</th>
              <th>{copy.progress}</th>
              <th>{copy.speed}</th>
              <th>{copy.eta}</th>
              <th>{copy.attempt}</th>
              <th>{copy.status}</th>
              <th><span className="srOnly">{copy.actions}</span></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((transfer) => {
              const progress = progressValue(transfer);
              const busy = busyId === transfer.transferId;
              return (
                <tr key={transfer.transferId} data-state={transfer.state}>
                  <td>
                    <div className="transferEndpoint">
                      <span className="transferFileIcon" data-direction={transfer.direction} aria-hidden="true">{transfer.direction === "upload" ? "⇧" : "⇩"}</span>
                      <span><strong title={personalInfo.maskText(transfer.sourceLabel)}>{personalInfo.maskText(transfer.sourceLabel)}</strong><small>{transfer.direction === "upload" ? ui.directionUpload : ui.directionDownload} · {formatBytes(transfer.total ?? transfer.bytes)}</small></span>
                    </div>
                  </td>
                  <td><div className="transferEndpoint"><span className="transferHostIcon" aria-hidden="true">▱</span><span><strong title={personalInfo.maskText(transfer.targetLabel)}>{personalInfo.maskText(transfer.targetLabel)}</strong><small>{personalInfo.maskText(transfer.hostAlias)}</small></span></div></td>
                  <td>
                    <div className="transferProgressLabel"><span>{formatBytes(transfer.bytes)} / {formatBytes(transfer.total)}</span><span>{progress === null ? "—" : `${progress.toFixed(0)}%`}</span></div>
                    <progress aria-label={ui.progressLabel} max={100} value={progress ?? undefined} />
                  </td>
                  <td>{transfer.speedBytesPerSecond ? `${formatBytes(transfer.speedBytesPerSecond)}/s` : "—"}</td>
                  <td>{transfer.etaSeconds === null ? "—" : `${transfer.etaSeconds} ${copy.seconds}`}</td>
                  <td>{transfer.attempt}</td>
                  <td><span className="transferStatus" data-state={transfer.state}><i aria-hidden="true" />{ui.status[transfer.state]}</span></td>
                  <td>
                    <div className="transferRowActions">
                      {transfer.capabilities.canPause ? <button aria-label={copy.pause} disabled={busy} title={copy.pause} type="button" onClick={() => onPause(transfer)}>Ⅱ</button> : null}
                      {transfer.capabilities.canResume ? <button aria-label={copy.resume} disabled={busy} title={copy.resume} type="button" onClick={() => onResume(transfer, false)}>▶</button> : null}
                      {transfer.capabilities.canRetry ? <button aria-label={copy.retry} disabled={busy} title={copy.retry} type="button" onClick={() => onResume(transfer, false)}>↻</button> : null}
                      {transfer.capabilities.canRestart ? <button aria-label={copy.restart} disabled={busy} title={copy.restart} type="button" onClick={() => onResume(transfer, true)}>↺</button> : null}
                      {transfer.capabilities.canCancel ? <button aria-label={copy.cancelTransfer} disabled={busy} title={copy.cancelTransfer} type="button" onClick={() => onCancel(transfer)}>×</button> : null}
                      {transfer.state === "waiting-conflict" && transfer.conflictRevision !== null ? <button aria-label={copy.actions} className="transferResolveButton" disabled={busy} type="button" onClick={() => onResolveConflict(transfer)}>!</button> : null}
                      {(transfer.errorCode || transfer.taskId) ? (
                        <details
                          className="transferMoreActions"
                          ref={(node) => {
                            if (node) moreActionsRef.current.set(transfer.transferId, node);
                            else moreActionsRef.current.delete(transfer.transferId);
                          }}
                        >
                          <summary aria-label={ui.moreActions}>•••</summary>
                          <div>
                            {transfer.errorCode ? <p><strong>{copy.errorCode}</strong><span>{transfer.errorCode}</span></p> : null}
                            {transfer.errorMessage ? <p>{transfer.errorMessage}</p> : null}
                            {transfer.taskId && onOpenTask ? <button type="button" onClick={() => onOpenTask(transfer.taskId!)}>{copy.viewTask}</button> : null}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 ? <div className="transferEmptyState">{transfers.length === 0 ? copy.transfersEmpty : ui.noMatches}</div> : null}
      </div>

      <footer className="transferPagination">
        <span>{filtered.length} {ui.results}</span>
        <label>
          <select aria-label={ui.pageSize} value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
            <option value={10}>10</option><option value={20}>20</option><option value={50}>50</option>
          </select>
          {ui.pageSize}
        </label>
        <div>
          <button aria-label={ui.previousPage} disabled={page <= 1} type="button" onClick={() => setPage((current) => current - 1)}>‹</button>
          <span>{ui.page} {page} {ui.of} {pageCount}</span>
          <button aria-label={ui.nextPage} disabled={page >= pageCount} type="button" onClick={() => setPage((current) => current + 1)}>›</button>
        </div>
      </footer>
    </section>
  );
}
