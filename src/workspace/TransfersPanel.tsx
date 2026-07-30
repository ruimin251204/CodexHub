import { useState } from "react";
import type { WorkspaceCopy } from "./copy";
import type {
  WorkspaceApi,
  WorkspaceConflictPolicy,
  WorkspaceLocalTransferRecovery,
  WorkspaceLocalTransferRecoveryPurgePreview,
  WorkspaceRecovery,
  WorkspaceRecoveryPurgePreview,
  WorkspaceTransfer
} from "./types";

function numberLabel(value: string | null) {
  if (value === null) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let scaled = numeric;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${scaled} ${units[unit]}` : `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${units[unit]}`;
}

function progressValue(transfer: WorkspaceTransfer) {
  if (!transfer.total) return null;
  const bytes = Number(transfer.bytes);
  const total = Number(transfer.total);
  if (!Number.isFinite(bytes) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (bytes / total) * 100));
}

export function TransfersPanel({
  api,
  copy,
  recoveries,
  transfers,
  onError,
  onOpenTask,
  onRecoveryUpdated,
  localRecoveries,
  onLocalRecoveryRemoved,
  onLocalRecoveryUpdated
}: {
  api: WorkspaceApi;
  copy: WorkspaceCopy;
  recoveries: WorkspaceRecovery[];
  transfers: WorkspaceTransfer[];
  onError: (error: unknown) => void;
  onOpenTask?: (taskId: string) => void;
  onRecoveryUpdated: (recovery: WorkspaceRecovery) => void;
  localRecoveries: WorkspaceLocalTransferRecovery[];
  onLocalRecoveryRemoved: (recoveryId: string) => void;
  onLocalRecoveryUpdated: (recovery: WorkspaceLocalTransferRecovery) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<WorkspaceTransfer | null>(null);
  const [conflictPolicy, setConflictPolicy] = useState<Exclude<WorkspaceConflictPolicy, "ask">>("keep-both");
  const [applyToBatch, setApplyToBatch] = useState(false);
  const [purgePreview, setPurgePreview] = useState<WorkspaceRecoveryPurgePreview | null>(null);
  const [localPurgePreview, setLocalPurgePreview] = useState<WorkspaceLocalTransferRecoveryPurgePreview | null>(null);

  const act = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    try {
      await action();
    } catch (error) {
      onError(error);
    } finally {
      setBusyId(null);
    }
  };

  const restore = (recovery: WorkspaceRecovery) => void act(recovery.recoveryId, async () => {
    const result = await api.restoreRecovery({ recoveryId: recovery.recoveryId });
    if (result.recovery) onRecoveryUpdated(result.recovery);
  });

  const preparePurge = (recovery: WorkspaceRecovery) => void act(recovery.recoveryId, async () => {
    setPurgePreview(await api.prepareRecoveryPurge({ recoveryId: recovery.recoveryId }));
  });

  const confirmPurge = () => {
    if (!purgePreview) return;
    const preview = purgePreview;
    void act(preview.recoveryId, async () => {
      onRecoveryUpdated(await api.purgeRecovery({ token: preview.token }));
      setPurgePreview(null);
    });
  };

  const restoreLocal = (recovery: WorkspaceLocalTransferRecovery) => void act(recovery.recoveryId, async () => {
    onLocalRecoveryUpdated(await api.restoreLocalTransferRecovery({ recoveryId: recovery.recoveryId }));
  });

  const prepareLocalPurge = (recovery: WorkspaceLocalTransferRecovery) => void act(recovery.recoveryId, async () => {
    setLocalPurgePreview(await api.prepareLocalTransferRecoveryPurge({ recoveryId: recovery.recoveryId }));
  });

  const confirmLocalPurge = () => {
    if (!localPurgePreview) return;
    const preview = localPurgePreview;
    void act(preview.recovery.recoveryId, async () => {
      await api.purgeLocalTransferRecovery({ token: preview.token });
      onLocalRecoveryRemoved(preview.recovery.recoveryId);
      setLocalPurgePreview(null);
    });
  };

  const resolveConflict = () => {
    if (!conflict?.conflictRevision) return;
    const pending = conflict;
    void act(pending.transferId, async () => {
      await api.resolveTransferConflict({
        transferId: pending.transferId,
        conflictRevision: pending.conflictRevision!,
        policy: conflictPolicy,
        applyToBatch
      });
      setConflict(null);
    });
  };

  const resumeOrReauthorize = async (transfer: WorkspaceTransfer, restart: boolean) => {
    const resume = (binding?: { fileSessionId: string; localGrantId: string }) => restart
      ? api.retryTransfer({ transferId: transfer.transferId, revision: transfer.revision, restart: true, ...binding })
      : api.resumeTransfer({ transferId: transfer.transferId, revision: transfer.revision, ...binding });
    try {
      await resume();
      return;
    } catch (error) {
      if (!String(error).includes("transfer-reauthorization-required")) throw error;
    }
    // Restarted workers lose local path authority by design. Reopen the
    // matching host's real Files session and let the native picker issue one
    // fresh opaque grant before asking Rust to compare durable fingerprints.
    const session = await api.openFiles({ hostAlias: transfer.hostAlias });
    if (transfer.direction === "upload") {
      const grants = await api.selectUploadSources();
      if (grants.length !== 1) throw new Error("Select exactly one original upload file to resume this transfer.");
      await resume({ fileSessionId: session.fileSessionId, localGrantId: grants[0].grantId });
      return;
    }
    const grant = await api.selectDownloadTarget();
    if (!grant) return;
    await resume({ fileSessionId: session.fileSessionId, localGrantId: grant.grantId });
  };

  return (
    <section className="workspaceTransfersPanel" aria-label={copy.modes.transfers}>
      <div className="workspaceTransfersTableWrap">
        <table className="workspaceTransfersTable">
          <thead>
            <tr>
              <th>{copy.transfer}</th>
              <th>{copy.source}</th>
              <th>{copy.destination}</th>
              <th>{copy.progress}</th>
              <th>{copy.speed}</th>
              <th>{copy.eta}</th>
              <th>{copy.attempt}</th>
              <th>{copy.status}</th>
              <th>{copy.actions}</th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((transfer) => {
              const progress = progressValue(transfer);
              const busy = busyId === transfer.transferId;
              return (
                <tr key={transfer.transferId} data-state={transfer.state}>
                  <td><span className="workspaceTransferDirection" data-direction={transfer.direction}>{transfer.direction === "upload" ? "⇧" : "⇩"}</span><span>{transfer.hostAlias}</span><small>{transfer.transferId}</small></td>
                  <td title={transfer.sourceLabel}>{transfer.sourceLabel}</td>
                  <td title={transfer.targetLabel}>{transfer.targetLabel}</td>
                  <td>
                    <div className="workspaceProgressLabel"><span>{numberLabel(transfer.bytes)} / {numberLabel(transfer.total)}</span><span>{progress === null ? "—" : `${progress.toFixed(0)}%`}</span></div>
                    <progress max={100} value={progress ?? undefined} />
                  </td>
                  <td>{transfer.speedBytesPerSecond ? `${numberLabel(transfer.speedBytesPerSecond)}/s` : "—"}</td>
                  <td>{transfer.etaSeconds === null ? "—" : `${transfer.etaSeconds} ${copy.seconds}`}</td>
                  <td>{transfer.attempt}</td>
                  <td><span className="workspaceStatusChip" data-state={transfer.state}>{transfer.state}</span></td>
                  <td>
                    <div className="workspaceTransferActions">
                      {transfer.capabilities.canPause ? <button disabled={busy} type="button" onClick={() => void act(transfer.transferId, () => api.pauseTransfer({ transferId: transfer.transferId, revision: transfer.revision }))}>{copy.pause}</button> : null}
                      {transfer.capabilities.canResume ? <button disabled={busy} type="button" onClick={() => void act(transfer.transferId, () => resumeOrReauthorize(transfer, false))}>{copy.resume}</button> : null}
                      {transfer.capabilities.canRetry ? <button disabled={busy} type="button" onClick={() => void act(transfer.transferId, () => resumeOrReauthorize(transfer, false))}>{copy.retry}</button> : null}
                      {transfer.capabilities.canRestart ? <button disabled={busy} type="button" onClick={() => void act(transfer.transferId, () => resumeOrReauthorize(transfer, true))}>{copy.restart}</button> : null}
                      {transfer.capabilities.canCancel ? <button disabled={busy} type="button" onClick={() => void act(transfer.transferId, () => api.cancelTransfer({ transferId: transfer.transferId, revision: transfer.revision }))}>{copy.cancelTransfer}</button> : null}
                      {transfer.state === "waiting-conflict" && transfer.conflictRevision !== null ? <button className="workspacePrimaryButton" disabled={busy} type="button" onClick={() => setConflict(transfer)}>{copy.actions}</button> : null}
                    </div>
                    {transfer.state === "failed" || transfer.errorCode ? (
                      <details className="workspaceTransferFailure">
                        <summary>{copy.failureDetails}</summary>
                        <dl>
                          <dt>{copy.errorCode}</dt><dd>{transfer.errorCode ?? copy.unknown}</dd>
                          <dt>{copy.resumeOffset}</dt><dd>{transfer.resumeOffset ?? "—"}</dd>
                          <dt>{copy.fingerprint}</dt><dd>{transfer.fingerprintState}</dd>
                        </dl>
                        {transfer.errorMessage ? <p>{transfer.errorMessage}</p> : null}
                        {transfer.taskId && onOpenTask ? <button type="button" onClick={() => onOpenTask(transfer.taskId!)}>{copy.viewTask}</button> : null}
                      </details>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {transfers.length === 0 ? <div className="workspaceEmptyState">{copy.transfersEmpty}</div> : null}
      </div>

      <section className="workspaceRecoveries" aria-labelledby="workspace-recovery-title">
        <h2 id="workspace-recovery-title">{copy.recoveries}</h2>
        {recoveries.length === 0 ? <p>{copy.recoveriesEmpty}</p> : (
          <div className="workspaceRecoveryList">
            {recoveries.map((recovery) => (
              <article className="workspaceRecoveryCard" key={recovery.recoveryId}>
                <header><strong>{recovery.operation}</strong><span className="workspaceStatusChip" data-state={recovery.state}>{recovery.state}</span></header>
                <dl>
                  <dt>{copy.host}</dt><dd>{recovery.hostAlias}</dd>
                  <dt>{copy.source}</dt><dd>{recovery.originalPath}</dd>
                  <dt>{copy.backup}</dt><dd>{recovery.recoveryPath}</dd>
                </dl>
                {recovery.reason ? <p role="alert">{recovery.reason}</p> : null}
                <div className="workspaceRecoveryActions">
                  <button disabled={busyId === recovery.recoveryId || recovery.state !== "available"} type="button" onClick={() => restore(recovery)}>{copy.restore}</button>
                  <button className="workspaceDangerButton" disabled={busyId === recovery.recoveryId || recovery.state !== "available"} type="button" onClick={() => preparePurge(recovery)}>{copy.purge}</button>
                  {recovery.taskId && onOpenTask ? <button type="button" onClick={() => onOpenTask(recovery.taskId!)}>{copy.viewTask}</button> : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="workspaceRecoveries" aria-labelledby="workspace-local-recovery-title">
        <h2 id="workspace-local-recovery-title">{copy.localRecoveries}</h2>
        {localRecoveries.length === 0 ? <p>{copy.localRecoveriesEmpty}</p> : (
          <div className="workspaceRecoveryList">
            {localRecoveries.map((recovery) => (
              <article className="workspaceRecoveryCard" key={recovery.recoveryId}>
                <header><strong>{copy.localDownloadReplacement}</strong><span className="workspaceStatusChip" data-state={recovery.state}>{recovery.state}</span></header>
                <dl>
                  <dt>{copy.destination}</dt><dd>{recovery.destinationName}</dd>
                  <dt>{copy.backup}</dt><dd>{recovery.backupName}</dd>
                </dl>
                <div className="workspaceRecoveryActions">
                  <button disabled={busyId === recovery.recoveryId || recovery.state !== "available"} type="button" onClick={() => restoreLocal(recovery)}>{copy.restore}</button>
                  <button className="workspaceDangerButton" disabled={busyId === recovery.recoveryId || recovery.state !== "available"} type="button" onClick={() => prepareLocalPurge(recovery)}>{copy.purge}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {conflict ? (
        <div className="workspaceInlineDialogBackdrop" role="presentation">
          <section aria-describedby="workspace-conflict-body" aria-labelledby="workspace-conflict-title" className="workspaceInlineDialog" role="alertdialog" aria-modal="true">
            <h3 id="workspace-conflict-title">{copy.conflictTitle}</h3>
            <p id="workspace-conflict-body">{copy.conflictBody}</p>
            <fieldset className="workspaceConflictChoices">
              <label><input checked={conflictPolicy === "skip"} name="conflict-policy" type="radio" onChange={() => setConflictPolicy("skip")} />{copy.skip}</label>
              <label><input checked={conflictPolicy === "keep-both"} name="conflict-policy" type="radio" onChange={() => setConflictPolicy("keep-both")} />{copy.keepBoth}</label>
              <label><input checked={conflictPolicy === "replace-with-backup"} name="conflict-policy" type="radio" onChange={() => setConflictPolicy("replace-with-backup")} />{copy.replaceWithBackup}</label>
            </fieldset>
            <label className="workspaceCheckbox"><input checked={applyToBatch} type="checkbox" onChange={(event) => setApplyToBatch(event.target.checked)} />{copy.applyToBatch}</label>
            <div className="workspaceDialogActions">
              <button type="button" onClick={() => setConflict(null)}>{copy.cancel}</button>
              <button className="workspacePrimaryButton" disabled={busyId === conflict.transferId} type="button" onClick={resolveConflict}>{copy.confirmOperation}</button>
            </div>
          </section>
        </div>
      ) : null}

      {purgePreview ? (
        <div className="workspaceInlineDialogBackdrop" role="presentation">
          <section aria-describedby="workspace-purge-body" aria-labelledby="workspace-purge-title" className="workspaceInlineDialog" role="alertdialog" aria-modal="true">
            <h3 id="workspace-purge-title">{copy.purgeTitle}</h3>
            <p id="workspace-purge-body">{copy.purgeBody}</p>
            <code>{purgePreview.recoveryPath}</code>
            <div className="workspaceDialogActions">
              <button type="button" onClick={() => setPurgePreview(null)}>{copy.cancel}</button>
              <button className="workspaceDangerButton" disabled={busyId === purgePreview.recoveryId} type="button" onClick={confirmPurge}>{copy.confirmPurge}</button>
            </div>
          </section>
        </div>
      ) : null}

      {localPurgePreview ? (
        <div className="workspaceInlineDialogBackdrop" role="presentation">
          <section aria-describedby="workspace-local-purge-body" aria-labelledby="workspace-local-purge-title" className="workspaceInlineDialog" role="alertdialog" aria-modal="true">
            <h3 id="workspace-local-purge-title">{copy.purgeTitle}</h3>
            <p id="workspace-local-purge-body">{copy.localPurgeBody}</p>
            <code>{localPurgePreview.recovery.backupName}</code>
            <div className="workspaceDialogActions">
              <button type="button" onClick={() => setLocalPurgePreview(null)}>{copy.cancel}</button>
              <button className="workspaceDangerButton" disabled={busyId === localPurgePreview.recovery.recoveryId} type="button" onClick={confirmLocalPurge}>{copy.confirmPurge}</button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
