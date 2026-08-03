import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { workspaceCopy } from "./copy";
import { TransfersPanel } from "./TransfersPanel";
import type { WorkspaceApi, WorkspaceLocalTransferRecovery, WorkspaceRecovery, WorkspaceTransfer } from "./types";

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

const runningTransfer: WorkspaceTransfer = {
  transferId: "transfer-running",
  revision: 3,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  direction: "upload",
  hostAlias: "host-a",
  sourceLabel: "dataset.tar.gz",
  targetLabel: "/home/a/dataset.tar.gz",
  state: "running",
  bytes: "524288",
  total: "1048576",
  speedBytesPerSecond: "131072",
  etaSeconds: 4,
  attempt: 1,
  resumable: true,
  resumeOffset: "524288",
  fingerprintState: "verified",
  errorCode: null,
  errorMessage: null,
  taskId: "task-transfer",
  conflictRevision: null,
  capabilities: { canPause: true, canResume: false, canCancel: true, canRetry: false, canRestart: false }
};

test("Transfer dashboard derives live statistics and preserves queue actions", async () => {
  const pauseTransfer = vi.fn().mockResolvedValue(undefined);
  render(
    <TransfersPanel
      api={{ pauseTransfer } as unknown as WorkspaceApi}
      copy={workspaceCopy.en}
      locale="en"
      recoveries={[]}
      localRecoveries={[]}
      transfers={[runningTransfer]}
      onError={vi.fn()}
      onRecoveryUpdated={vi.fn()}
      onLocalRecoveryRemoved={vi.fn()}
      onLocalRecoveryUpdated={vi.fn()}
    />
  );

  const todayCard = screen.getByText("Today").closest("article");
  expect(todayCard).not.toBeNull();
  expect(within(todayCard!).getByText("1")).toBeInTheDocument();
  expect(screen.getByText("dataset.tar.gz")).toBeInTheDocument();
  expect(screen.getByText("50%")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  await waitFor(() => expect(pauseTransfer).toHaveBeenCalledWith({ transferId: "transfer-running", revision: 3 }));
});

test("transfer more-actions menu closes from an outside press or Escape", () => {
  render(
    <TransfersPanel
      api={{} as WorkspaceApi}
      copy={workspaceCopy.en}
      locale="en"
      recoveries={[]}
      localRecoveries={[]}
      transfers={[runningTransfer]}
      onError={vi.fn()}
      onRecoveryUpdated={vi.fn()}
      onLocalRecoveryRemoved={vi.fn()}
      onLocalRecoveryUpdated={vi.fn()}
    />
  );

  const menu = document.querySelector<HTMLDetailsElement>(".transferMoreActions");
  const toggle = menu?.querySelector<HTMLElement>("summary");
  expect(menu).not.toBeNull();
  expect(toggle).not.toBeNull();
  if (!menu || !toggle) throw new Error("Transfer more-actions menu is unavailable");

  fireEvent.click(toggle);
  expect(menu.open).toBe(true);
  fireEvent.pointerDown(toggle);
  expect(menu.open).toBe(true);

  fireEvent.pointerDown(document.body);
  expect(menu.open).toBe(false);

  fireEvent.click(toggle);
  expect(menu.open).toBe(true);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(menu.open).toBe(false);
  expect(toggle).toHaveFocus();
});

test("Transfer header uses the parent workspace title and keeps refresh and new-transfer actions", async () => {
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const onNewTransfer = vi.fn();
  render(
    <TransfersPanel
      api={{} as WorkspaceApi}
      copy={workspaceCopy.en}
      locale="en"
      recoveries={[]}
      localRecoveries={[]}
      transfers={[]}
      onError={vi.fn()}
      onNewTransfer={onNewTransfer}
      onRefresh={onRefresh}
      onRecoveryUpdated={vi.fn()}
      onLocalRecoveryRemoved={vi.fn()}
      onLocalRecoveryUpdated={vi.fn()}
    />
  );

  const panel = document.querySelector<HTMLElement>(".workspaceTransfersPanel");
  expect(panel).not.toBeNull();
  expect(panel).toHaveAttribute("aria-label", "Transfers");
  expect(within(panel!).queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  expect(within(panel!).getByText("Manage cross-host uploads, downloads, and recovery tasks")).toBeInTheDocument();

  const refreshButton = within(panel!).getByRole("button", { name: "Refresh" });
  const newTransferButton = within(panel!).getByRole("button", { name: "New transfer" });
  expect(refreshButton).toHaveClass("secondaryButton", "pageActionButton");
  expect(newTransferButton).toHaveClass("primaryButton", "pageActionButton");
  expect(refreshButton.querySelector(".pageActionIcon")).toBeInTheDocument();
  expect(newTransferButton.querySelector(".pageActionIcon")).toBeInTheDocument();
  fireEvent.click(refreshButton);
  await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  fireEvent.click(newTransferButton);
  expect(onNewTransfer).toHaveBeenCalledTimes(1);
});

test("Backup and recent-transfer cards are collapsed by default and share one toggle", () => {
  render(
    <TransfersPanel
      api={{} as WorkspaceApi}
      copy={workspaceCopy.en}
      locale="en"
      recoveries={[recovery]}
      localRecoveries={[]}
      transfers={[runningTransfer]}
      onError={vi.fn()}
      onRecoveryUpdated={vi.fn()}
      onLocalRecoveryRemoved={vi.fn()}
      onLocalRecoveryUpdated={vi.fn()}
    />
  );

  const expand = screen.getByRole("button", { name: "Expand backups and recent transfers" });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("heading", { name: "Recovery backups" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Recent transfers" })).not.toBeInTheDocument();

  fireEvent.click(expand);
  expect(screen.getByRole("heading", { name: "Recovery backups" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Local download backups" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Recent transfers" })).toBeInTheDocument();

  const collapse = screen.getByRole("button", { name: "Collapse backups and recent transfers" });
  expect(collapse).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(collapse);
  expect(screen.queryByRole("heading", { name: "Recovery backups" })).not.toBeInTheDocument();
});

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

  fireEvent.click(screen.getByRole("button", { name: "Expand backups and recent transfers" }));
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

  fireEvent.click(screen.getByRole("button", { name: "Expand backups and recent transfers" }));
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
