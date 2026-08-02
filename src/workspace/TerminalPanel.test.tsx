import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { workspaceCopy } from "./copy";
import { TerminalPanel } from "./TerminalPanel";
import type { WorkspaceApi, WorkspaceHost, WorkspaceTerminalSession } from "./types";
import { defaultTerminalPreferences } from "./types";

vi.mock("./XtermTerminal", () => ({
  WORKSPACE_TERMINAL_FOCUS_EVENT: "codexhub:workspace-terminal-focus",
  XtermTerminal: ({ active, session }: { active: boolean; session: WorkspaceTerminalSession }) => (
    <div data-active={active} data-testid={`xterm-${session.sessionId}`} />
  )
}));

function terminalSession(sessionId: string, hostAlias: string): WorkspaceTerminalSession {
  return {
    sessionId,
    hostAlias,
    title: hostAlias,
    generation: 1,
    revision: 1,
    state: "connected",
    reconnectable: false,
    autoReconnect: true,
    attempt: 0,
    nextRetryAt: null,
    reason: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    taskId: null
  };
}

function workspaceHost(hostAlias: string): WorkspaceHost {
  return {
    id: `host-${hostAlias}`,
    name: hostAlias,
    hostAlias,
    status: "online"
  };
}

function renderPanel(
  sessions: WorkspaceTerminalSession[],
  onHostSelected = vi.fn(),
  options: {
    hosts?: WorkspaceHost[];
    isFilesSplit?: boolean;
    onRequestFilesSplit?: () => void;
    onToggleFilesSplit?: () => void;
    selectedHostAlias?: string;
  } = {}
) {
  const onActivateSession = vi.fn();
  const onRequestFilesSplit = options.onRequestFilesSplit ?? vi.fn();
  const onToggleFilesSplit = options.onToggleFilesSplit ?? vi.fn();
  render(
    <TerminalPanel
      activeSessionId={sessions[0]?.sessionId ?? null}
      api={{} as WorkspaceApi}
      copy={workspaceCopy.en}
      hosts={options.hosts ?? sessions.map((session) => workspaceHost(session.hostAlias))}
      locale="en"
      platform="windows"
      preferences={defaultTerminalPreferences}
      selectedHostAlias={options.selectedHostAlias}
      sessions={sessions}
      onActivateSession={onActivateSession}
      onCloseSession={vi.fn()}
      onError={vi.fn()}
      onHostSelected={onHostSelected}
      onReconnect={vi.fn()}
      onRendererError={vi.fn()}
      isFilesSplit={options.isFilesSplit ?? false}
      onRequestFilesSplit={onRequestFilesSplit}
      onToggleFilesSplit={onToggleFilesSplit}
    />
  );
  return { onActivateSession, onHostSelected, onRequestFilesSplit, onToggleFilesSplit };
}

test("split terminal requests the outer Files + Terminal layout through its toggle callback", () => {
  const sessions = [terminalSession("one", "alpha"), terminalSession("two", "beta")];
  const { onToggleFilesSplit } = renderPanel(sessions);

  fireEvent.click(screen.getByRole("button", { name: "Split with files" }));

  expect(screen.getByTestId("xterm-one").closest(".chTerminalInstance")).toHaveAttribute("data-visible", "true");
  expect(screen.getByTestId("xterm-two").closest(".chTerminalInstance")).toHaveAttribute("data-visible", "false");
  expect(screen.getByTestId("xterm-one")).toHaveAttribute("data-active", "true");
  expect(onToggleFilesSplit).toHaveBeenCalledOnce();
});

test("split close label delegates to the parent and does not create a second PTY session", () => {
  const onHostSelected = vi.fn();
  const { onToggleFilesSplit } = renderPanel([terminalSession("one", "alpha")], onHostSelected, { isFilesSplit: true });

  fireEvent.click(screen.getByRole("button", { name: "Close split" }));

  expect(onToggleFilesSplit).toHaveBeenCalledOnce();
  expect(onHostSelected).not.toHaveBeenCalled();
  expect(screen.getByTestId("xterm-one")).toBeInTheDocument();
});

test("new terminal without a PTY opens a host picker before creating a session", () => {
  const onHostSelected = vi.fn();
  renderPanel([], onHostSelected, {
    hosts: [workspaceHost("alpha"), workspaceHost("beta")],
    selectedHostAlias: "beta"
  });

  expect(screen.queryByRole("combobox", { name: "Session host" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "New terminal" }));

  const dialog = screen.getByRole("dialog", { name: "Choose a host" });
  expect(within(dialog).getByRole("button", { name: "alpha" })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "beta" }));

  expect(onHostSelected).toHaveBeenCalledWith("beta");
  expect(screen.queryByRole("dialog", { name: "Choose a host" })).not.toBeInTheDocument();
});

test("terminal toolbar keeps only the requested four controls and a separate theme preference", () => {
  const session = { ...terminalSession("one", "ssh-prod-us-west-01"), title: "Production" };
  renderPanel([session]);
  const toolbar = document.querySelector<HTMLElement>(".chTerminalToolbar")!;
  const tabs = within(toolbar).getByRole("tablist", { name: "Terminal tabs" });

  expect(document.querySelector(".chTerminal")).toHaveAttribute("data-terminal-theme", "dark");
  expect(tabs).toBeInTheDocument();
  expect(within(tabs).getByRole("tab", { name: "ssh-prod-us-west-01" })).toHaveTextContent("ssh-prod-us-west-01");
  expect(within(tabs).queryByText("Production")).not.toBeInTheDocument();
  expect(within(tabs).getByRole("button", { name: "New terminal" })).toHaveClass("chTerminalTabAdd");
  expect(within(toolbar).getByRole("button", { name: "Split with files" })).toBeInTheDocument();
  expect(within(toolbar).getByRole("button", { name: "Full screen" })).toBeInTheDocument();
  expect(within(toolbar).getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  const themeToggle = toolbar.querySelector<HTMLElement>('summary[aria-label="Theme"]');
  expect(themeToggle).toBeInTheDocument();
  expect(toolbar.querySelectorAll('[data-label-mode="responsive"]')).toHaveLength(4);
  expect(within(toolbar).queryByRole("button", { name: "Copy selection" })).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole("button", { name: "Search terminal" })).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();

  fireEvent.click(themeToggle!);
  expect(screen.getByRole("menuitemradio", { name: "Use terminal setting" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("menuitemradio", { name: "Dark" })).toBeInTheDocument();
  expect(screen.getByRole("menuitemradio", { name: "Light" })).toBeInTheDocument();
  expect(screen.getByRole("menuitemradio", { name: "High contrast" })).toBeInTheDocument();
});

test("theme menu closes from an outside press or Escape without treating its toolbar as outside", () => {
  renderPanel([terminalSession("one", "alpha")]);

  const menu = document.querySelector<HTMLDetailsElement>(".chTerminalMenu");
  const toggle = menu?.querySelector<HTMLElement>("summary");
  expect(menu).not.toBeNull();
  expect(toggle).not.toBeNull();
  if (!menu || !toggle) throw new Error("Theme menu is unavailable");

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
