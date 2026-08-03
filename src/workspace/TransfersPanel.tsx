import { useState } from "react";
import type { WorkspaceCopy } from "./copy";
import type {
  WorkspaceApi,
  WorkspaceConflictPolicy,
  WorkspaceLocalTransferRecovery,
  WorkspaceLocalTransferRecoveryPurgePreview,
  WorkspaceRecovery,
  WorkspaceRecoveryPurgePreview,
  WorkspaceTransfer,
  WorkspaceLocale
} from "./types";
import { transferUiCopy } from "./transfers/copy";
import { TransferRecoveryCards } from "./transfers/TransferRecoveryCards";
import { TransferStats } from "./transfers/TransferStats";
import { TransferTable } from "./transfers/TransferTable";
import "./transfers-redesign.css";
import { usePersonalInfoMasking } from "../ui/PersonalInfoMasking";
import { ActionIcon } from "../components/UI/ActionIcon";

export function TransfersPanel({
  api,
  copy,
  locale,
  recoveries,
  transfers,
  onNewTransfer,
  onRefresh,
  onError,
  onOpenTask,
  onRecoveryUpdated,
  localRecoveries,
  onLocalRecoveryRemoved,
  onLocalRecoveryUpdated
}: {
  api: WorkspaceApi;
  copy: WorkspaceCopy;
  locale?: WorkspaceLocale;
  recoveries: WorkspaceRecovery[];
  transfers: WorkspaceTransfer[];
  onNewTransfer?: () => void;
  onRefresh?: () => Promise<void> | void;
  onError: (error: unknown) => void;
  onOpenTask?: (taskId: string) => void;
  onRecoveryUpdated: (recovery: WorkspaceRecovery) => void;
  localRecoveries: WorkspaceLocalTransferRecovery[];
  onLocalRecoveryRemoved: (recoveryId: string) => void;
  onLocalRecoveryUpdated: (recovery: WorkspaceLocalTransferRecovery) => void;
}) {
  const resolvedLocale = locale ?? "en";
  const ui = transferUiCopy[resolvedLocale];
  const personalInfo = usePersonalInfoMasking();
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

  const refresh = () => {
    if (!onRefresh) return;
    void act("refresh", async () => { await onRefresh(); });
  };

  return (
    <section aria-describedby="transfer-page-description" className="workspaceTransfersPanel" aria-label={copy.modes.transfers}>
      <header className="transferPageHeader">
        <div className="transferPageIntro">
          <span className="transferPageIcon" aria-hidden="true">⇩</span>
          <p id="transfer-page-description">{ui.description}</p>
        </div>
        <div className="transferPageActions">
          {onRefresh ? <button className="secondaryButton pageActionButton" disabled={busyId === "refresh"} type="button" onClick={refresh}><ActionIcon name="refresh" /><span>{ui.refresh}</span></button> : null}
          {onNewTransfer ? <button className="primaryButton pageActionButton transferPrimaryAction" type="button" onClick={onNewTransfer}><ActionIcon name="add" /><span>{ui.newTransfer}</span></button> : null}
        </div>
      </header>

      <div className="transferPageContent">
        <TransferStats copy={ui} transfers={transfers} />
        <TransferTable
          busyId={busyId}
          copy={copy}
          transfers={transfers}
          ui={ui}
          onCancel={(transfer) => void act(transfer.transferId, () => api.cancelTransfer({ transferId: transfer.transferId, revision: transfer.revision }))}
          onOpenTask={onOpenTask}
          onPause={(transfer) => void act(transfer.transferId, () => api.pauseTransfer({ transferId: transfer.transferId, revision: transfer.revision }))}
          onResolveConflict={setConflict}
          onResume={(transfer, restart) => void act(transfer.transferId, () => resumeOrReauthorize(transfer, restart))}
        />
        <TransferRecoveryCards
          busyId={busyId}
          copy={copy}
          locale={resolvedLocale}
          localRecoveries={localRecoveries}
          recoveries={recoveries}
          transfers={transfers}
          ui={ui}
          onOpenTask={onOpenTask}
          onPrepareLocalPurge={prepareLocalPurge}
          onPreparePurge={preparePurge}
          onRestore={restore}
          onRestoreLocal={restoreLocal}
        />
      </div>

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
            <code>{personalInfo.maskText(purgePreview.recoveryPath)}</code>
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
