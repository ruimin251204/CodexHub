import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { workspaceCopy } from "./copy";
import { FilesPanel, formatModifiedAt } from "./FilesPanel";
import type {
  RemoteFileEntry,
  WorkspaceApi,
  WorkspaceDirectoryPage,
  WorkspaceFilesSession,
  WorkspaceHost
} from "./types";

const host: WorkspaceHost = {
  id: "host-1",
  name: "Demo host",
  hostAlias: "demo",
  status: "online"
};

const session: WorkspaceFilesSession = {
  fileSessionId: "files-1",
  hostAlias: "demo",
  homePath: "/home/demo",
  currentPath: "/home/demo",
  state: "connected",
  reason: null
};

const directory: RemoteFileEntry = {
  entryRef: "entry-projects",
  canonicalPath: "/home/demo/projects",
  name: "projects",
  kind: "directory",
  size: "0",
  modifiedAt: "2024-07-03T09:46:40Z",
  permissions: "755",
  uid: "1000",
  gid: "1000",
  symlinkTarget: null,
  fingerprint: "0:1720000000:Directory",
  nameEncoding: "utf8",
  readable: true,
  writable: true
};

function page(path: string, entries: RemoteFileEntry[]): WorkspaceDirectoryPage {
  return {
    fileSessionId: session.fileSessionId,
    canonicalPath: path,
    snapshotId: `snapshot-${path}`,
    entries,
    nextCursor: null,
    totalKnown: entries.length,
    truncated: false
  };
}

function renderPanel() {
  const listDirectory = vi.fn(async ({ path }: { path: string | null }) =>
    path === directory.canonicalPath
      ? page(directory.canonicalPath, [])
      : page(session.homePath, [directory]));
  const stop = () => undefined;
  const api = {
    openFiles: vi.fn().mockResolvedValue(session),
    listDirectory,
    events: {
      onFileSearchUpdated: vi.fn().mockReturnValue(stop),
      onLocalDrop: vi.fn().mockReturnValue(stop)
    }
  } as unknown as WorkspaceApi;

  render(
    <FilesPanel
      activeTerminal={null}
      api={api}
      copy={workspaceCopy.en}
      cwd={null}
      followCwd={false}
      hosts={[host]}
      isActive
      selectedHostAlias={host.hostAlias}
      onError={vi.fn()}
      onFollowCwdChange={vi.fn()}
      onHostSelected={vi.fn()}
      onOpenTerminalAt={vi.fn()}
      onRecoveryCreated={vi.fn()}
      onViewRecoveries={vi.fn()}
    />
  );
  return listDirectory;
}

function errorPanel(
  api: WorkspaceApi,
  onError: ReturnType<typeof vi.fn>,
  options: { isActive?: boolean; selectedHostAlias?: string; hosts?: WorkspaceHost[] } = {}
) {
  return (
    <FilesPanel
      activeTerminal={null}
      api={api}
      copy={workspaceCopy.en}
      cwd={null}
      followCwd={false}
      hosts={options.hosts ?? [host]}
      isActive={options.isActive ?? true}
      selectedHostAlias={options.selectedHostAlias ?? host.hostAlias}
      onError={onError}
      onFollowCwdChange={vi.fn()}
      onHostSelected={vi.fn()}
      onOpenTerminalAt={vi.fn()}
      onRecoveryCreated={vi.fn()}
      onViewRecoveries={vi.fn()}
    />
  );
}

function renderErrorPanel(api: WorkspaceApi, onError: ReturnType<typeof vi.fn>) {
  return render(errorPanel(api, onError));
}

test("invalid remote timestamps never render Invalid Date", () => {
  expect(formatModifiedAt(null)).toBe("—");
  expect(formatModifiedAt("not-a-date")).toBe("—");
  expect(formatModifiedAt("2024-07-03T09:46:40Z")).not.toBe("—");
  expect(formatModifiedAt("2024-07-03T09:46:40Z")).not.toContain("Invalid");
});

test.each(["double-click", "enter"])("%s opens a directory by canonical POSIX path", async (action) => {
  const listDirectory = renderPanel();
  const row = await screen.findByRole("row", { name: /projects/i });

  if (action === "double-click") fireEvent.doubleClick(row);
  else fireEvent.keyDown(row, { key: "Enter" });

  await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith(expect.objectContaining({
    fileSessionId: session.fileSessionId,
    path: directory.canonicalPath
  })));
});

test("initial directory failure is visible and successful retry clears it", async () => {
  const listDirectory = vi.fn()
    .mockRejectedValueOnce(new Error("invalid-remote-path"))
    .mockResolvedValueOnce(page(session.homePath, []));
  const stop = () => undefined;
  const api = {
    openFiles: vi.fn().mockResolvedValue(session),
    closeFiles: vi.fn().mockResolvedValue(undefined),
    listDirectory,
    events: {
      onFileSearchUpdated: vi.fn().mockReturnValue(stop),
      onLocalDrop: vi.fn().mockReturnValue(stop)
    }
  } as unknown as WorkspaceApi;
  const onError = vi.fn();
  renderErrorPanel(api, onError);

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(workspaceCopy.en.filesUnavailable));
  expect(screen.queryByText(workspaceCopy.en.emptyDirectory)).not.toBeInTheDocument();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "invalid-remote-path" }));

  fireEvent.click(screen.getByRole("button", { name: workspaceCopy.en.retryLoad }));

  await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(api.closeFiles).toHaveBeenCalledWith({ fileSessionId: session.fileSessionId });
  expect(screen.getByText(workspaceCopy.en.emptyDirectory)).toBeInTheDocument();
});

test("mode changes preserve the active host directory without reopening Files", async () => {
  const listDirectory = vi.fn(async ({ path }: { path: string | null }) =>
    path === directory.canonicalPath
      ? page(directory.canonicalPath, [])
      : page(session.homePath, [directory]));
  const stop = () => undefined;
  const api = {
    openFiles: vi.fn().mockResolvedValue(session),
    listDirectory,
    events: {
      onFileSearchUpdated: vi.fn().mockReturnValue(stop),
      onLocalDrop: vi.fn().mockReturnValue(stop)
    }
  } as unknown as WorkspaceApi;
  const onError = vi.fn();
  const view = renderErrorPanel(api, onError);

  fireEvent.doubleClick(await screen.findByRole("row", { name: /projects/i }));
  await screen.findByDisplayValue(directory.canonicalPath);
  const callsBeforeModeChange = listDirectory.mock.calls.length;

  view.rerender(errorPanel(api, onError, { isActive: false }));
  view.rerender(errorPanel(api, onError, { isActive: true }));

  await screen.findByDisplayValue(directory.canonicalPath);
  expect(api.openFiles).toHaveBeenCalledTimes(1);
  expect(listDirectory).toHaveBeenCalledTimes(callsBeforeModeChange);
});

test("an unfinished Files view reloads after returning to the mode", async () => {
  let resolveInitialDirectory: (value: WorkspaceDirectoryPage) => void = () => undefined;
  const listDirectory = vi.fn()
    .mockImplementationOnce(() => new Promise<WorkspaceDirectoryPage>((resolve) => { resolveInitialDirectory = resolve; }))
    .mockResolvedValueOnce(page(session.homePath, [directory]));
  const stop = () => undefined;
  const api = {
    openFiles: vi.fn().mockResolvedValue(session),
    closeFiles: vi.fn().mockResolvedValue(undefined),
    listDirectory,
    events: {
      onFileSearchUpdated: vi.fn().mockReturnValue(stop),
      onLocalDrop: vi.fn().mockReturnValue(stop)
    }
  } as unknown as WorkspaceApi;
  const onError = vi.fn();
  const view = renderErrorPanel(api, onError);

  await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1));
  view.rerender(errorPanel(api, onError, { isActive: false }));
  resolveInitialDirectory(page(session.homePath, [directory]));
  view.rerender(errorPanel(api, onError, { isActive: true }));

  await waitFor(() => expect(api.openFiles).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("row", { name: /projects/i })).toBeInTheDocument();
});

test("changing hosts while Files is inactive does not restore the previous host view", async () => {
  const otherHost: WorkspaceHost = { ...host, id: "host-2", name: "Other host", hostAlias: "other" };
  const otherSession = { ...session, fileSessionId: "files-2", hostAlias: otherHost.hostAlias };
  const stop = () => undefined;
  const api = {
    openFiles: vi.fn(async ({ hostAlias }: { hostAlias: string }) => hostAlias === otherHost.hostAlias ? otherSession : session),
    listDirectory: vi.fn(async ({ fileSessionId }: { fileSessionId: string }) =>
      fileSessionId === otherSession.fileSessionId
        ? { ...page("/home/other", []), fileSessionId: otherSession.fileSessionId }
        : page(session.homePath, [directory])),
    events: {
      onFileSearchUpdated: vi.fn().mockReturnValue(stop),
      onLocalDrop: vi.fn().mockReturnValue(stop)
    }
  } as unknown as WorkspaceApi;
  const onError = vi.fn();
  const hosts = [host, otherHost];
  const view = render(errorPanel(api, onError, { hosts }));

  await screen.findByRole("row", { name: /projects/i });
  view.rerender(errorPanel(api, onError, { hosts, isActive: false }));
  view.rerender(errorPanel(api, onError, { hosts, isActive: false, selectedHostAlias: otherHost.hostAlias }));
  view.rerender(errorPanel(api, onError, { hosts, selectedHostAlias: otherHost.hostAlias }));

  await screen.findByText(workspaceCopy.en.emptyDirectory);
  expect(api.openFiles).toHaveBeenLastCalledWith({ hostAlias: otherHost.hostAlias });
  expect(screen.queryByRole("row", { name: /projects/i })).not.toBeInTheDocument();
});

test("a failed host view is reopened and keeps a visible retry action across host switches", async () => {
  const otherHost: WorkspaceHost = { ...host, id: "host-2", name: "Other host", hostAlias: "other" };
  const otherSession = { ...session, fileSessionId: "files-2", hostAlias: otherHost.hostAlias };
  const listDirectory = vi.fn(async ({ fileSessionId }: { fileSessionId: string }) => {
    if (fileSessionId === session.fileSessionId) throw new Error("directory-open-failed");
    return { ...page("/home/other", []), fileSessionId: otherSession.fileSessionId };
  });
  const stop = () => undefined;
  const api = {
    openFiles: vi.fn(async ({ hostAlias }: { hostAlias: string }) => hostAlias === otherHost.hostAlias ? otherSession : session),
    closeFiles: vi.fn().mockResolvedValue(undefined),
    listDirectory,
    events: {
      onFileSearchUpdated: vi.fn().mockReturnValue(stop),
      onLocalDrop: vi.fn().mockReturnValue(stop)
    }
  } as unknown as WorkspaceApi;
  const onError = vi.fn();
  const hosts = [host, otherHost];
  const view = render(errorPanel(api, onError, { hosts }));

  await screen.findByRole("alert");
  view.rerender(errorPanel(api, onError, { hosts, selectedHostAlias: otherHost.hostAlias }));
  await screen.findByText(workspaceCopy.en.emptyDirectory);
  view.rerender(errorPanel(api, onError, { hosts, selectedHostAlias: host.hostAlias }));

  expect(await screen.findByRole("alert")).toHaveTextContent(workspaceCopy.en.filesUnavailable);
  expect(api.closeFiles).toHaveBeenCalledWith({ fileSessionId: session.fileSessionId });
  expect(api.openFiles).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("button", { name: workspaceCopy.en.retryLoad })).toBeInTheDocument();
});

test("retry after a child-directory failure requests the same directory", async () => {
  let childAttempts = 0;
  const listDirectory = vi.fn(async ({ path }: { path: string | null }) => {
    if (path === directory.canonicalPath && childAttempts++ === 0) {
      throw new Error("directory-open-failed");
    }
    return path === directory.canonicalPath
      ? page(directory.canonicalPath, [])
      : page(session.homePath, [directory]);
  });
  const stop = () => undefined;
  const api = {
    openFiles: vi.fn().mockResolvedValue(session),
    closeFiles: vi.fn().mockResolvedValue(undefined),
    listDirectory,
    events: {
      onFileSearchUpdated: vi.fn().mockReturnValue(stop),
      onLocalDrop: vi.fn().mockReturnValue(stop)
    }
  } as unknown as WorkspaceApi;
  const onError = vi.fn();
  renderErrorPanel(api, onError);

  fireEvent.doubleClick(await screen.findByRole("row", { name: /projects/i }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: workspaceCopy.en.retryLoad }));

  await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith(expect.objectContaining({
    path: directory.canonicalPath
  })));
  expect(api.closeFiles).toHaveBeenCalledWith({ fileSessionId: session.fileSessionId });
  await screen.findByDisplayValue(directory.canonicalPath);
  expect(screen.getByText(workspaceCopy.en.emptyDirectory)).toBeInTheDocument();
});
