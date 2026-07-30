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
