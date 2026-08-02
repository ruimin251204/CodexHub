import type { WorkspaceCopy } from "../copy";
import type { WorkspaceLocalTransferRecovery, WorkspaceRecovery, WorkspaceTransfer } from "../types";
import type { TransferUiCopy } from "./copy";
import { formatBytes, formatDateTime } from "./format";
import { usePersonalInfoMasking } from "../../ui/PersonalInfoMasking";

export function TransferRecoveryCards({
  busyId,
  copy,
  locale,
  localRecoveries,
  onOpenTask,
  onPrepareLocalPurge,
  onPreparePurge,
  onRestore,
  onRestoreLocal,
  recoveries,
  transfers,
  ui
}: {
  busyId: string | null;
  copy: WorkspaceCopy;
  locale: "en" | "zh";
  localRecoveries: WorkspaceLocalTransferRecovery[];
  onOpenTask?: (taskId: string) => void;
  onPrepareLocalPurge: (recovery: WorkspaceLocalTransferRecovery) => void;
  onPreparePurge: (recovery: WorkspaceRecovery) => void;
  onRestore: (recovery: WorkspaceRecovery) => void;
  onRestoreLocal: (recovery: WorkspaceLocalTransferRecovery) => void;
  recoveries: WorkspaceRecovery[];
  transfers: WorkspaceTransfer[];
  ui: TransferUiCopy;
}) {
  const personalInfo = usePersonalInfoMasking();
  const recent = [...transfers].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);

  return (
    <section className="transferSupportGrid">
      <article className="transferSupportCard">
        <header><span className="transferSupportIcon" aria-hidden="true">↶</span><div><h2>{ui.restoreBackups}</h2><p>{ui.restoreBackupsHint}</p></div></header>
        <div className="transferSupportList">
          {recoveries.length === 0 ? <p className="transferSupportEmpty">{copy.recoveriesEmpty}</p> : recoveries.map((recovery) => (
            <div className="transferRecoveryItem" key={recovery.recoveryId}>
              <div><strong>{recovery.operation}</strong><small>{formatDateTime(recovery.createdAt, locale)}</small><span title={personalInfo.maskText(recovery.recoveryPath)}>{personalInfo.maskText(`${recovery.hostAlias} · ${recovery.originalPath}`)}</span></div>
              <div className="transferRecoveryActions">
                <button disabled={busyId === recovery.recoveryId || recovery.state !== "available"} type="button" onClick={() => onRestore(recovery)}>{copy.restore}</button>
                <button className="transferDangerAction" disabled={busyId === recovery.recoveryId || recovery.state !== "available"} type="button" onClick={() => onPreparePurge(recovery)}>{copy.purge}</button>
                {recovery.taskId && onOpenTask ? <button type="button" onClick={() => onOpenTask(recovery.taskId!)}>{copy.viewTask}</button> : null}
              </div>
            </div>
          ))}
        </div>
      </article>

      <article className="transferSupportCard">
        <header><span className="transferSupportIcon" aria-hidden="true">⇩</span><div><h2>{ui.localBackups}</h2><p>{ui.localBackupsHint}</p></div></header>
        <div className="transferSupportList">
          {localRecoveries.length === 0 ? <p className="transferSupportEmpty">{copy.localRecoveriesEmpty}</p> : localRecoveries.map((recovery) => (
            <div className="transferRecoveryItem" key={recovery.recoveryId}>
              <div><strong>{recovery.destinationName}</strong><small>{formatDateTime(recovery.createdAt, locale)}</small><span>{ui.backupPath}: {recovery.backupName}</span></div>
              <div className="transferRecoveryActions">
                <button disabled={busyId === recovery.recoveryId || recovery.state !== "available"} type="button" onClick={() => onRestoreLocal(recovery)}>{copy.restore}</button>
                <button className="transferDangerAction" disabled={busyId === recovery.recoveryId || recovery.state !== "available"} type="button" onClick={() => onPrepareLocalPurge(recovery)}>{copy.purge}</button>
              </div>
            </div>
          ))}
        </div>
      </article>

      <article className="transferSupportCard">
        <header><span className="transferSupportIcon" aria-hidden="true">◷</span><div><h2>{ui.recentTransfers}</h2><p>{ui.recentTransfersHint}</p></div></header>
        <div className="transferSupportList">
          {recent.length === 0 ? <p className="transferSupportEmpty">{ui.noRecent}</p> : recent.map((transfer) => (
            <div className="transferRecentItem" key={transfer.transferId}>
              <span className="transferFileIcon" data-direction={transfer.direction} aria-hidden="true">{transfer.direction === "upload" ? "⇧" : "⇩"}</span>
              <div><strong title={personalInfo.maskText(`${transfer.sourceLabel} → ${transfer.targetLabel}`)}>{personalInfo.maskText(`${transfer.sourceLabel} → ${transfer.targetLabel}`)}</strong><small>{formatBytes(transfer.total ?? transfer.bytes)} · {formatDateTime(transfer.updatedAt, locale)}</small></div>
              <span className="transferStatus" data-state={transfer.state}><i aria-hidden="true" />{ui.status[transfer.state]}</span>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}
