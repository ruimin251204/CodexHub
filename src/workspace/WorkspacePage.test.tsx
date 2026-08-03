import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { WorkspacePage } from "./WorkspacePage";
import { defaultTerminalPreferences } from "./types";
import type {
  WorkspaceApi,
  WorkspaceHost,
  WorkspaceTerminalHostRequest,
  WorkspaceTerminalSession
} from "./types";

vi.mock("./FilesPanel", () => ({
  WORKSPACE_FILES_LOCATION_EVENT: "codexhub:workspace-files-location",
  FilesPanel: ({ selectedHostAlias }: { selectedHostAlias: string }) => <div data-testid="files-panel">{selectedHostAlias || "local"}</div>
}));

vi.mock("./TransfersPanel", () => ({
  TransfersPanel: () => <div data-testid="transfers-panel" />
}));

vi.mock("./TerminalPanel", () => ({
  TerminalPanel: ({
    activeSessionId,
    sessions,
    onActivateSession,
    onCloseSession,
    onToggleFilesSplit
  }: {
    activeSessionId: string | null;
    sessions: WorkspaceTerminalSession[];
    onActivateSession: (sessionId: string) => void;
    onCloseSession: (session: WorkspaceTerminalSession) => void;
    onToggleFilesSplit?: () => void;
  }) => (
    <div>
      <output data-testid="active-terminal">{activeSessionId ?? "none"}</output>
      <button type="button" onClick={() => onActivateSession("terminal-beta")}>Activate beta</button>
      <button type="button" onClick={onToggleFilesSplit}>Split Files</button>
      <button
        disabled={!sessions.some((session) => session.sessionId === "terminal-beta")}
        type="button"
        onClick={() => {
          const session = sessions.find((candidate) => candidate.sessionId === "terminal-beta");
          if (session) onCloseSession(session);
        }}
      >Close beta</button>
    </div>
  )
}));

function terminalSession(
  sessionId: string,
  hostAlias: string,
  createdAt = "2026-08-01T00:00:00.000Z"
): WorkspaceTerminalSession {
  return {
    sessionId,
    hostAlias,
    title: hostAlias,
    generation: 1,
    revision: 1,
    state: "connected",
    reconnectable: true,
    autoReconnect: true,
    attempt: 0,
    nextRetryAt: null,
    reason: null,
    createdAt,
    taskId: null
  };
}

const hosts: WorkspaceHost[] = [
  { id: "host-alpha", name: "Alpha", hostAlias: "alpha", status: "online" },
  { id: "host-beta", name: "Beta", hostAlias: "beta", status: "online" }
];

function createWorkspaceApi(
  sessions: WorkspaceTerminalSession[],
  openedSession = terminalSession("terminal-beta", "beta")
) {
  const stop = () => undefined;
  return {
    closeTerminal: vi.fn().mockResolvedValue(undefined),
    listTerminalSessions: vi.fn().mockResolvedValue(sessions),
    listTransfers: vi.fn().mockResolvedValue({ transfers: [], recoveries: [], localRecoveries: [] }),
    openTerminal: vi.fn().mockResolvedValue(openedSession),
    events: {
      onSessionState: vi.fn().mockReturnValue(stop),
      onSessionHeartbeat: vi.fn().mockReturnValue(stop),
      onTerminalCwd: vi.fn().mockReturnValue(stop),
      onTransferUpdated: vi.fn().mockReturnValue(stop)
    }
  } as unknown as WorkspaceApi;
}

function renderWorkspace({
  api,
  mode,
  selectedHostAlias = "alpha",
  terminalHostRequest = null,
  onSelectedHostChange = vi.fn(),
  onTerminalHostRequestHandled = vi.fn()
}: {
  api: WorkspaceApi;
  mode?: "terminal" | "files" | "split" | "transfers";
  selectedHostAlias?: string;
  terminalHostRequest?: WorkspaceTerminalHostRequest | null;
  onSelectedHostChange?: ReturnType<typeof vi.fn>;
  onTerminalHostRequestHandled?: ReturnType<typeof vi.fn>;
}) {
  render(
    <WorkspacePage
      api={api}
      hosts={hosts}
      locale="en"
      mode={mode}
      platform="windows"
      selectedHostAlias={selectedHostAlias}
      terminalHostRequest={terminalHostRequest}
      terminalPreferences={defaultTerminalPreferences}
      onError={vi.fn()}
      onSelectedHostChange={onSelectedHostChange}
      onTerminalHostRequestHandled={onTerminalHostRequestHandled}
      onTerminalRendererError={vi.fn()}
    />
  );
  return { onSelectedHostChange, onTerminalHostRequestHandled };
}

test("Files defaults to the first restored terminal host", async () => {
  const onSelectedHostChange = vi.fn();
  const api = createWorkspaceApi([
    terminalSession("terminal-alpha", "alpha", "2026-08-01T00:00:00.000Z"),
    terminalSession("terminal-beta", "beta", "2026-08-01T00:00:01.000Z")
  ]);
  renderWorkspace({ api, mode: "files", selectedHostAlias: "", onSelectedHostChange });

  await waitFor(() => expect(onSelectedHostChange).toHaveBeenCalledWith("alpha"));
});

test("Files defaults to the local target when no terminal exists", async () => {
  const onSelectedHostChange = vi.fn();
  renderWorkspace({ api: createWorkspaceApi([]), mode: "files", selectedHostAlias: "alpha", onSelectedHostChange });

  await waitFor(() => expect(onSelectedHostChange).toHaveBeenCalledWith(""));
});

test("activating a terminal keeps the selected Terminal host aligned with its PTY", async () => {
  const onSelectedHostChange = vi.fn();
  const api = createWorkspaceApi([
    terminalSession("terminal-beta", "beta", "2026-08-01T00:00:00.000Z"),
    terminalSession("terminal-alpha", "alpha", "2026-08-01T00:00:01.000Z")
  ]);
  renderWorkspace({ api, onSelectedHostChange });

  await waitFor(() => expect(screen.getByTestId("active-terminal")).toHaveTextContent("terminal-alpha"));
  onSelectedHostChange.mockClear();

  fireEvent.click(screen.getByRole("button", { name: "Activate beta" }));

  expect(screen.getByTestId("active-terminal")).toHaveTextContent("terminal-beta");
  expect(onSelectedHostChange).toHaveBeenCalledWith("beta");
});

test("one-shot terminal host request reuses an existing restored PTY", async () => {
  const onTerminalHostRequestHandled = vi.fn();
  const api = createWorkspaceApi([
    terminalSession("terminal-beta", "beta"),
    terminalSession("terminal-alpha", "alpha")
  ]);
  const { onSelectedHostChange } = renderWorkspace({
    api,
    terminalHostRequest: { requestId: 17, hostAlias: "beta" },
    onTerminalHostRequestHandled
  });

  await waitFor(() => expect(screen.getByTestId("active-terminal")).toHaveTextContent("terminal-beta"));

  expect(api.openTerminal).not.toHaveBeenCalled();
  expect(onTerminalHostRequestHandled).toHaveBeenCalledTimes(1);
  expect(onTerminalHostRequestHandled).toHaveBeenCalledWith(17);
  expect(onSelectedHostChange).toHaveBeenLastCalledWith("beta");
});

test("one-shot terminal host request creates a PTY only when the host has no session", async () => {
  const openedSession = terminalSession("terminal-beta-new", "beta");
  const api = createWorkspaceApi([terminalSession("terminal-alpha", "alpha")], openedSession);
  const onTerminalHostRequestHandled = vi.fn();
  renderWorkspace({
    api,
    terminalHostRequest: { requestId: 18, hostAlias: "beta" },
    onTerminalHostRequestHandled
  });

  await waitFor(() => expect(api.openTerminal).toHaveBeenCalledWith({
    hostAlias: "beta",
    columns: 120,
    rows: 32,
    initialDirectory: null
  }));
  await waitFor(() => expect(screen.getByTestId("active-terminal")).toHaveTextContent("terminal-beta-new"));

  expect(onTerminalHostRequestHandled).toHaveBeenCalledTimes(1);
  expect(onTerminalHostRequestHandled).toHaveBeenCalledWith(18);
});

test("closing a background terminal leaves the focused PTY and host unchanged", async () => {
  const onSelectedHostChange = vi.fn();
  const beta = terminalSession("terminal-beta", "beta", "2026-08-01T00:00:00.000Z");
  const api = createWorkspaceApi([beta, terminalSession("terminal-alpha", "alpha", "2026-08-01T00:00:01.000Z")]);
  renderWorkspace({ api, onSelectedHostChange });

  await waitFor(() => expect(screen.getByTestId("active-terminal")).toHaveTextContent("terminal-alpha"));
  onSelectedHostChange.mockClear();

  fireEvent.click(screen.getByRole("button", { name: "Close beta" }));

  await waitFor(() => expect(api.closeTerminal).toHaveBeenCalledWith({
    sessionId: beta.sessionId,
    generation: beta.generation
  }));
  expect(screen.getByTestId("active-terminal")).toHaveTextContent("terminal-alpha");
  expect(onSelectedHostChange).not.toHaveBeenCalled();
});

test("terminal split opens and closes the Files-left layout at its default forty-percent ratio", () => {
  const api = createWorkspaceApi([terminalSession("terminal-alpha", "alpha")]);
  const onModeChange = vi.fn();
  render(
    <WorkspacePage
      api={api}
      hosts={hosts}
      locale="en"
      platform="windows"
      selectedHostAlias="alpha"
      terminalPreferences={defaultTerminalPreferences}
      onError={vi.fn()}
      onModeChange={onModeChange}
      onTerminalRendererError={vi.fn()}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Split Files" }));

  expect(onModeChange).toHaveBeenCalledWith("split");
  expect(screen.getByTestId("files-panel").closest(".workspaceModeFiles")).toHaveAttribute("aria-hidden", "false");
  expect(document.querySelector(".workspacePageBody")).toHaveStyle({ "--workspace-split-ratio": "40%" });

  fireEvent.click(screen.getByRole("button", { name: "Split Files" }));

  expect(onModeChange).toHaveBeenLastCalledWith("terminal");
  expect(screen.getByTestId("files-panel").closest(".workspaceModeFiles")).toHaveAttribute("aria-hidden", "true");
});

test("a narrow Workspace uses a horizontal splitter with vertical keyboard controls", async () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  class ResizeObserverMock {
    constructor(_callback: ResizeObserverCallback) {}
    disconnect() {}
    observe() {}
    unobserve() {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

  try {
    const api = createWorkspaceApi([terminalSession("terminal-alpha", "alpha")]);
    render(
      <WorkspacePage
        api={api}
        hosts={hosts}
        locale="en"
        platform="windows"
        selectedHostAlias="alpha"
        terminalPreferences={defaultTerminalPreferences}
        onError={vi.fn()}
        onTerminalRendererError={vi.fn()}
      />
    );

    const body = document.querySelector<HTMLElement>(".workspacePageBody");
    expect(body).not.toBeNull();
    vi.spyOn(body!, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 720,
      top: 0,
      width: 720,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect);

    fireEvent.click(screen.getByRole("button", { name: "Split Files" }));

    await waitFor(() => expect(body).toHaveAttribute("data-split-layout", "stacked"));
    const splitter = screen.getByRole("separator", { name: "Resize Files and Terminal panes" });
    expect(splitter).toHaveAttribute("aria-orientation", "horizontal");

    fireEvent.keyDown(splitter, { key: "ArrowDown" });
    expect(body).toHaveStyle({ "--workspace-split-ratio": "45%" });
  } finally {
    globalThis.ResizeObserver = originalResizeObserver;
  }
});
