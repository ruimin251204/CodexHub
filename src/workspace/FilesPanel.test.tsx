import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { workspaceCopy } from "./copy";
import { FilesPanel, formatModifiedAt } from "./FilesPanel";
import { workspaceHostLabel } from "./hostLabel";
import { resolveFileColumnWidths } from "./files/FileTable";
import { filesUiCopy } from "./files/filesUiCopy";
import { childPath, parentPath } from "./files/fileDisplay";
import { createPersonalInfoMasker } from "../personalInfo";
import { PersonalInfoMaskingProvider } from "../ui/PersonalInfoMasking";
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

test("Windows drive paths keep their root while navigating", () => {
  expect(parentPath("C:/Users/demo")).toBe("C:/Users");
  expect(parentPath("C:/Users")).toBe("C:/");
  expect(parentPath("C:/")).toBe("C:/");
  expect(childPath("C:/", "Users")).toBe("C:/Users");
});

const session: WorkspaceFilesSession = {
  fileSessionId: "files-1",
  hostAlias: "demo",
  targetKind: "remote",
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

const hiddenDirectory: RemoteFileEntry = {
  ...directory,
  entryRef: "entry-hidden",
  canonicalPath: "/home/demo/.config",
  name: ".config"
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

function renderPanel(entries: RemoteFileEntry[] = [directory], options: { masking?: boolean; compact?: boolean } = {}) {
  const listDirectory = vi.fn(async ({ path }: { path: string | null }) =>
    path === directory.canonicalPath
      ? page(directory.canonicalPath, [])
      : page(session.homePath, entries));
  const stop = () => undefined;
  const api = {
    openFiles: vi.fn().mockResolvedValue(session),
    listDirectory,
    events: {
      onFileSearchUpdated: vi.fn().mockReturnValue(stop),
      onLocalDrop: vi.fn().mockReturnValue(stop)
    }
  } as unknown as WorkspaceApi;

  const panel = (
    <FilesPanel
      activeTerminal={null}
      api={api}
      copy={workspaceCopy.en}
      cwd={null}
      followCwd={false}
      hosts={[host]}
      isActive
      compact={options.compact}
      selectedHostAlias={host.hostAlias}
      onError={vi.fn()}
      onFollowCwdChange={vi.fn()}
      onHostSelected={vi.fn()}
      onOpenTerminalAt={vi.fn()}
      onRecoveryCreated={vi.fn()}
      onViewRecoveries={vi.fn()}
    />
  );
  render(options.masking ? (
    <PersonalInfoMaskingProvider value={createPersonalInfoMasker(true, [{ username: "demo" }])}>
      {panel}
    </PersonalInfoMaskingProvider>
  ) : panel);
  return listDirectory;
}

function errorPanel(
  api: WorkspaceApi,
  onError: ReturnType<typeof vi.fn>,
  options: { isActive?: boolean; selectedHostAlias?: string; hosts?: WorkspaceHost[]; locale?: "en" | "zh" } = {}
) {
  const locale = options.locale ?? "en";
  return (
    <FilesPanel
      activeTerminal={null}
      api={api}
      copy={workspaceCopy[locale]}
      cwd={null}
      followCwd={false}
      hosts={options.hosts ?? [host]}
      isActive={options.isActive ?? true}
      locale={locale}
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

test("matching host names and aliases render only once", () => {
  expect(workspaceHostLabel({ ...host, name: "demo" })).toBe("demo");
  expect(workspaceHostLabel(host)).toBe("Demo host · demo");
});

test("quick access stays outside the scrollable directory tree at the card bottom", async () => {
  renderPanel();

  const tree = await screen.findByRole("tree", { name: filesUiCopy.en.directoryTree });
  const treeScroll = tree.closest<HTMLElement>(".workspaceFilesTreeScroll");
  const quickAccess = screen.getByRole("heading", { name: filesUiCopy.en.quickAccess }).closest<HTMLElement>(".workspaceFilesQuickAccess");

  expect(treeScroll).not.toContainElement(quickAccess);
  expect(quickAccess?.parentElement).toHaveClass("workspaceFilesTree");
  expect(quickAccess?.previousElementSibling).toBe(treeScroll);
});

test("connected Files host keeps status inside the compact host selector", async () => {
  renderPanel();

  const hostSelect = screen.getByRole("combobox", { name: workspaceCopy.en.host });
  await screen.findByRole("tree", { name: filesUiCopy.en.directoryTree });
  const hostPicker = hostSelect.closest<HTMLElement>(".workspaceFilesHostPicker");

  expect(hostPicker).toHaveAttribute("data-connected", "true");
  expect(hostPicker?.querySelector(".workspaceFilesHostStatus")).toHaveAttribute("aria-label", filesUiCopy.en.sftpConnected);
  expect(hostPicker?.textContent).not.toContain(workspaceCopy.en.host);
  expect(screen.queryByText(filesUiCopy.en.sftpConnected)).not.toBeInTheDocument();
});

test("the local Files target opens the real local file session", async () => {
  const stop = () => undefined;
  const localSession: WorkspaceFilesSession = {
    ...session,
    fileSessionId: "local-files",
    hostAlias: "",
    targetKind: "local",
    homePath: "C:/",
    currentPath: "C:/"
  };
  const api = {
    openFiles: vi.fn().mockResolvedValue(localSession),
    listDirectory: vi.fn().mockResolvedValue(page("C:/", [])),
    events: {
      onFileSearchUpdated: vi.fn().mockReturnValue(stop),
      onLocalDrop: vi.fn().mockReturnValue(stop)
    }
  } as unknown as WorkspaceApi;

  render(errorPanel(api, vi.fn(), { selectedHostAlias: "" }));

  await waitFor(() => expect(api.openFiles).toHaveBeenCalledWith({ hostAlias: "" }));
  expect(api.listDirectory).toHaveBeenCalledWith(expect.objectContaining({ fileSessionId: "local-files", path: "C:/" }));
});

test("dot-prefixed paths are hidden by default and can be revealed", async () => {
  renderPanel([directory, hiddenDirectory]);

  expect(await screen.findByRole("row", { name: /projects/i })).toBeInTheDocument();
  expect(screen.queryByRole("row", { name: /.config/i })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: workspaceCopy.en.showHidden }));
  expect(await screen.findByRole("row", { name: /.config/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: workspaceCopy.en.hideHidden }));
  expect(screen.queryByRole("row", { name: /.config/i })).not.toBeInTheDocument();
});

test("the focused two-pane view keeps only name, size and modified file columns", async () => {
  renderPanel();

  const grid = await screen.findByRole("grid", { name: filesUiCopy.en.tableView });

  expect(within(grid).getByRole("columnheader", { name: workspaceCopy.en.fileName })).toBeInTheDocument();
  expect(within(grid).getByRole("columnheader", { name: workspaceCopy.en.fileSize })).toBeInTheDocument();
  expect(within(grid).getByRole("columnheader", { name: workspaceCopy.en.fileModified })).toBeInTheDocument();
  expect(within(grid).queryByRole("columnheader", { name: workspaceCopy.en.fileType })).not.toBeInTheDocument();
  expect(within(grid).queryByRole("columnheader", { name: filesUiCopy.en.permissions })).not.toBeInTheDocument();
  expect(within(grid).queryByRole("columnheader", { name: filesUiCopy.en.owner })).not.toBeInTheDocument();
  expect(screen.queryByRole("complementary", { name: filesUiCopy.en.details })).not.toBeInTheDocument();
});

test("directory tree keeps the real remote user name visible when personal masking is enabled", async () => {
  renderPanel([directory], { masking: true });

  const tree = await screen.findByRole("tree", { name: filesUiCopy.en.directoryTree });
  expect(within(tree).getByRole("button", { name: "demo" })).toBeInTheDocument();
  expect(within(tree).queryByRole("button", { name: "d*" })).not.toBeInTheDocument();
});

test("Files more-actions menu closes from an outside press or Escape", async () => {
  renderPanel();
  await screen.findByRole("grid", { name: filesUiCopy.en.tableView });

  const menu = document.querySelector<HTMLDetailsElement>(".workspaceFilesMoreActions");
  const toggle = menu?.querySelector<HTMLElement>("summary");
  expect(menu).not.toBeNull();
  expect(toggle).not.toBeNull();
  if (!menu || !toggle) throw new Error("Files more-actions menu is unavailable");

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

test("directory tree and file columns expose pointer resize controls", async () => {
  renderPanel();

  await screen.findByRole("grid", { name: filesUiCopy.en.tableView });
  const explorer = document.querySelector<HTMLDivElement>(".workspaceFilesExplorer");
  expect(explorer).not.toBeNull();
  if (!explorer) throw new Error("Files explorer is unavailable");
  Object.defineProperty(explorer, "clientWidth", { configurable: true, value: 1000 });

  const treeResizeHandle = screen.getByRole("separator", { name: filesUiCopy.en.resizeDirectoryTree });
  fireEvent.pointerDown(treeResizeHandle, { button: 0, clientX: 248 });
  fireEvent.pointerMove(window, { clientX: 320 });
  expect(explorer.style.getPropertyValue("--workspace-files-tree-width")).toBe("320px");
  fireEvent.pointerUp(window);

  const nameResizeHandle = screen.getByRole("separator", { name: `${filesUiCopy.en.resizeColumn}: ${workspaceCopy.en.fileName}` });
  fireEvent.pointerDown(nameResizeHandle, { button: 0, clientX: 100 });
  fireEvent.pointerMove(window, { clientX: 180 });
  expect(screen.getByRole("grid", { name: filesUiCopy.en.tableView }).style.getPropertyValue("--workspace-file-name-column-width")).toBe("420px");
  fireEvent.pointerUp(window);
});

test("compact Files starts with its directory tree collapsed and can open it on demand", async () => {
  renderPanel([directory], { compact: true });

  await screen.findByRole("grid", { name: filesUiCopy.en.tableView });
  expect(screen.queryByRole("tree", { name: filesUiCopy.en.directoryTree })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: filesUiCopy.en.showTree }));
  expect(await screen.findByRole("tree", { name: filesUiCopy.en.directoryTree })).toBeInTheDocument();
});

test("entering compact Files closes the tree once without overriding a later user choice", async () => {
  const stop = () => undefined;
  const api = {
    openFiles: vi.fn().mockResolvedValue(session),
    listDirectory: vi.fn().mockResolvedValue(page(session.homePath, [directory])),
    events: {
      onFileSearchUpdated: vi.fn().mockReturnValue(stop),
      onLocalDrop: vi.fn().mockReturnValue(stop)
    }
  } as unknown as WorkspaceApi;
  const panelProps = {
    activeTerminal: null,
    api,
    copy: workspaceCopy.en,
    cwd: null,
    followCwd: false,
    hosts: [host],
    isActive: true,
    selectedHostAlias: host.hostAlias,
    onError: vi.fn(),
    onFollowCwdChange: vi.fn(),
    onHostSelected: vi.fn(),
    onOpenTerminalAt: vi.fn(),
    onRecoveryCreated: vi.fn(),
    onViewRecoveries: vi.fn()
  };
  const renderPanelForMode = (compact: boolean) => <FilesPanel {...panelProps} compact={compact} />;
  const view = render(renderPanelForMode(false));

  expect(await screen.findByRole("tree", { name: filesUiCopy.en.directoryTree })).toBeInTheDocument();
  view.rerender(renderPanelForMode(true));
  await waitFor(() => expect(screen.queryByRole("tree", { name: filesUiCopy.en.directoryTree })).not.toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: filesUiCopy.en.showTree }));
  expect(await screen.findByRole("tree", { name: filesUiCopy.en.directoryTree })).toBeInTheDocument();

  view.rerender(renderPanelForMode(true));
  expect(await screen.findByRole("tree", { name: filesUiCopy.en.directoryTree })).toBeInTheDocument();
});

test("file columns fit the compact table viewport without horizontal overflow", () => {
  const widths = resolveFileColumnWidths({ name: 340, size: 124, modified: 188 }, 230, true);

  expect(widths.name).toBeGreaterThan(0);
  expect(widths.size).toBeGreaterThan(0);
  expect(widths.modified).toBeGreaterThan(0);
  expect(widths.name + widths.size + widths.modified).toBe(182);
});

test("directory tree expansion lazily lists the selected real canonical path", async () => {
  const listDirectory = renderPanel();
  const tree = await screen.findByRole("tree", { name: filesUiCopy.en.directoryTree });

  fireEvent.click(within(tree).getByRole("button", { name: `${filesUiCopy.en.expandDirectory}: ${directory.name}` }));

  await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith(expect.objectContaining({
    fileSessionId: session.fileSessionId,
    path: directory.canonicalPath,
    sort: "name",
    direction: "asc"
  })));
});

test("client pagination and page checkboxes keep selection explicit", async () => {
  const entries = Array.from({ length: 30 }, (_, index): RemoteFileEntry => ({
    ...directory,
    entryRef: `entry-${index}`,
    canonicalPath: `${session.homePath}/item-${index}`,
    name: `item-${index}`,
    kind: "file"
  }));
  renderPanel(entries);
  await screen.findByRole("row", { name: /item-0/i });

  fireEvent.change(screen.getByRole("combobox", { name: filesUiCopy.en.rowsPerPage }), { target: { value: "25" } });
  await waitFor(() => expect(screen.queryByRole("row", { name: /item-29/i })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("checkbox", { name: filesUiCopy.en.selectAllPage }));
  expect(screen.getByLabelText(/25 selected/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: filesUiCopy.en.nextPage }));
  expect(await screen.findByRole("row", { name: /item-29/i })).toBeInTheDocument();
});

test("Files-specific redesign copy follows the requested locale", async () => {
  const stop = () => undefined;
  const api = { openFiles: vi.fn(), events: { onFileSearchUpdated: vi.fn().mockReturnValue(stop), onLocalDrop: vi.fn().mockReturnValue(stop) } } as unknown as WorkspaceApi;

  render(errorPanel(api, vi.fn(), { selectedHostAlias: "", locale: "zh" }));

  expect(await screen.findByRole("complementary", { name: filesUiCopy.zh.directoryTree })).toBeInTheDocument();
  expect(screen.queryByRole("complementary", { name: filesUiCopy.zh.details })).not.toBeInTheDocument();
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
