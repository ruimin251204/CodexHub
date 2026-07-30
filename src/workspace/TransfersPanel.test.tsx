import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { workspaceCopy } from "./copy";
import { TransfersPanel } from "./TransfersPanel";
import type { WorkspaceApi, WorkspaceLocalTransferRecovery, WorkspaceRecovery } from "./types";

const recovery: WorkspaceRecovery = {
  recoveryId: "recovery-1",
  hostAlias: "host-a",
  operation: "delete",
  originalPath: "/home/a/report.txt",
  recoveryPath: "/home/a/.codexhub-workspace-backups/recovery-1",
  createdAt: "2026-07-30T00:00:00Z",
  state: "available",
  taskId: null,
  reason: null
};

test("Recovery remains explicitly restorable and requires a second purge confirmation", async () => {
  const restoreRecovery = vi.fn().mockResolvedValue({ taskId: "task-1", recovery: { ...recovery, state: "restored" } });
  const prepareRecoveryPurge = vi.fn().mockResolvedValue({ token: "purge-token", recoveryId: recovery.recoveryId, hostAlias: recovery.hostAlias, recoveryPath: recovery.recoveryPath, expiresAt: "2026-07-30T00:01:00Z" });
  const purgeRecovery = vi.fn().mockResolvedValue({ ...recovery, state: "purged" });
  const onRecoveryUpdated = vi.fn();
  const api = { restoreRecovery, prepareRecoveryPurge, purgeRecovery } as unknown as WorkspaceApi;

  render(
    <TransfersPanel
      api={api}
      copy={workspaceCopy.en}
      recoveries={[recovery]}
      localRecoveries={[]}
      transfers={[]}
      onError={vi.fn()}
      onRecoveryUpdated={onRecoveryUpdated}
      onLocalRecoveryRemoved={vi.fn()}
      onLocalRecoveryUpdated={vi.fn()}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(restoreRecovery).toHaveBeenCalledWith({ recoveryId: recovery.recoveryId }));
  expect(onRecoveryUpdated).toHaveBeenCalledWith(expect.objectContaining({ state: "restored" }));

  fireEvent.click(screen.getByRole("button", { name: "Permanently delete backup" }));
  await waitFor(() => expect(prepareRecoveryPurge).toHaveBeenCalledWith({ recoveryId: recovery.recoveryId }));
  expect(purgeRecovery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete backup permanently" }));
  await waitFor(() => expect(purgeRecovery).toHaveBeenCalledWith({ token: "purge-token" }));
  expect(onRecoveryUpdated).toHaveBeenCalledWith(expect.objectContaining({ recoveryId: recovery.recoveryId, state: "purged" }));
});

test("Local download recovery reveals only names and requires a second purge confirmation", async () => {
  const localRecovery: WorkspaceLocalTransferRecovery = {
    recoveryId: "local-recovery-1",
    transferId: "transfer-1",
    destinationName: "report.txt",
    backupName: "payload",
    state: "available",
    createdAt: "2026-07-30T00:00:00Z",
    restoredAt: null,
    purgedAt: null
  };
  const restoreLocalTransferRecovery = vi.fn().mockResolvedValue({ ...localRecovery, state: "restored" });
  const prepareLocalTransferRecoveryPurge = vi.fn().mockResolvedValue({ token: "local-purge-token", recovery: localRecovery, expiresAt: "2026-07-30T00:01:00Z" });
  const purgeLocalTransferRecovery = vi.fn().mockResolvedValue(undefined);
  const onLocalRecoveryUpdated = vi.fn();
  const onLocalRecoveryRemoved = vi.fn();
  const api = {
    restoreLocalTransferRecovery,
    prepareLocalTransferRecoveryPurge,
    purgeLocalTransferRecovery
  } as unknown as WorkspaceApi;

  render(
    <TransfersPanel
      api={api}
      copy={workspaceCopy.en}
      recoveries={[]}
      localRecoveries={[localRecovery]}
      transfers={[]}
      onError={vi.fn()}
      onRecoveryUpdated={vi.fn()}
      onLocalRecoveryRemoved={onLocalRecoveryRemoved}
      onLocalRecoveryUpdated={onLocalRecoveryUpdated}
    />
  );

  expect(screen.getByText("report.txt")).toBeInTheDocument();
  expect(screen.queryByText(/Users|CodexHub/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(restoreLocalTransferRecovery).toHaveBeenCalledWith({ recoveryId: localRecovery.recoveryId }));
  expect(onLocalRecoveryUpdated).toHaveBeenCalledWith(expect.objectContaining({ state: "restored" }));

  fireEvent.click(screen.getByRole("button", { name: "Permanently delete backup" }));
  await waitFor(() => expect(prepareLocalTransferRecoveryPurge).toHaveBeenCalledWith({ recoveryId: localRecovery.recoveryId }));
  expect(purgeLocalTransferRecovery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete backup permanently" }));
  await waitFor(() => expect(purgeLocalTransferRecovery).toHaveBeenCalledWith({ token: "local-purge-token" }));
  expect(onLocalRecoveryRemoved).toHaveBeenCalledWith(localRecovery.recoveryId);
});
