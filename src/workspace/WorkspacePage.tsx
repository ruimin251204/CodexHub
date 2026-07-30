import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { workspaceCopy } from "./copy";
import { useWorkspaceController } from "./controller";
import { FilesPanel, WORKSPACE_FILES_LOCATION_EVENT } from "./FilesPanel";
import { TerminalPanel } from "./TerminalPanel";
import { TransfersPanel } from "./TransfersPanel";
import type {
  WorkspaceApi,
  WorkspaceHost,
  WorkspaceLocale,
  WorkspaceMode,
  WorkspacePlatform,
  WorkspaceTerminalPreferences,
  WorkspaceTerminalSession
} from "./types";

const TERMINAL_COLUMNS = 120;
const TERMINAL_ROWS = 32;
const WORKSPACE_MODES: WorkspaceMode[] = ["terminal", "files", "split", "transfers"];

function isTerminalTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(".workspaceXtermCanvas, .xterm"));
}

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

function nextActiveSession(sessions: WorkspaceTerminalSession[], closingId: string) {
  const index = sessions.findIndex((session) => session.sessionId === closingId);
  return sessions[index + 1]?.sessionId ?? sessions[index - 1]?.sessionId ?? null;
}

/** Full Workspace composition.  It only consumes the real desktop API adapter. */
export function WorkspacePage({
  api,
  className,
  defaultMode = "terminal",
  hosts,
  initialHostAlias = "",
  locale,
  onError,
  onModeChange,
  onOpenTask,
  platform,
  terminalPreferences
}: {
  api: WorkspaceApi;
  className?: string;
  defaultMode?: WorkspaceMode;
  hosts: WorkspaceHost[];
  initialHostAlias?: string;
  locale: WorkspaceLocale;
  onError: (error: unknown) => void;
  onModeChange?: (mode: WorkspaceMode) => void;
  onOpenTask?: (taskId: string) => void;
  platform: WorkspacePlatform;
  terminalPreferences: WorkspaceTerminalPreferences;
}) {
  const copy = workspaceCopy[locale];
  const controller = useWorkspaceController(api, onError);
  const [mode, setMode] = useState<WorkspaceMode>(defaultMode);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedHostAlias, setSelectedHostAlias] = useState(initialHostAlias);
  const [followCwd, setFollowCwd] = useState(true);
  const [splitRatio, setSplitRatio] = useState(60);
  const [closeTarget, setCloseTarget] = useState<WorkspaceTerminalSession | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const modeTabRefs = useRef(new Map<WorkspaceMode, HTMLButtonElement>());

  const sessions = useMemo(
    () => controller.state.sessions.filter((session) => session.state !== "closed"),
    [controller.state.sessions]
  );
  const activeTerminal = sessions.find((session) => session.sessionId === activeSessionId) ?? null;
  const cwd = activeTerminal ? controller.state.cwdBySession[activeTerminal.sessionId] ?? null : null;

  useEffect(() => {
    if (selectedHostAlias || hosts.length === 0) return;
    setSelectedHostAlias(hosts[0].hostAlias);
  }, [hosts, selectedHostAlias]);

  useEffect(() => {
    if (activeSessionId && sessions.some((session) => session.sessionId === activeSessionId)) return;
    setActiveSessionId(sessions[sessions.length - 1]?.sessionId ?? null);
  }, [activeSessionId, sessions]);

  const chooseMode = (next: WorkspaceMode) => {
    setMode(next);
    onModeChange?.(next);
  };

  const selectRelativeMode = (delta: number) => {
    const current = WORKSPACE_MODES.indexOf(mode);
    const next = WORKSPACE_MODES[(current + delta + WORKSPACE_MODES.length) % WORKSPACE_MODES.length];
    chooseMode(next);
    requestAnimationFrame(() => modeTabRefs.current.get(next)?.focus());
  };

  const selectModeAndFocus = (next: WorkspaceMode) => {
    chooseMode(next);
    requestAnimationFrame(() => modeTabRefs.current.get(next)?.focus());
  };

  const openTerminal = async (
    hostAlias: string,
    initialDirectory?: { fileSessionId: string; path: string }
  ) => {
    if (!hostAlias) return;
    try {
      const existing = sessions.find((session) => session.hostAlias === hostAlias && session.state !== "closing");
      if (!initialDirectory && existing) {
        setActiveSessionId(existing.sessionId);
        setSelectedHostAlias(hostAlias);
        chooseMode("terminal");
        return;
      }
      const session = await api.openTerminal({
        hostAlias,
        columns: TERMINAL_COLUMNS,
        rows: TERMINAL_ROWS,
        initialDirectory: initialDirectory ?? null
      });
      controller.upsertSession(session);
      setActiveSessionId(session.sessionId);
      setSelectedHostAlias(hostAlias);
      chooseMode("terminal");
    } catch (error) {
      onError(error);
    }
  };

  const reconnect = async (session: WorkspaceTerminalSession) => {
    try {
      const reconnected = await api.reconnectTerminal({ sessionId: session.sessionId });
      controller.upsertSession(reconnected);
      setActiveSessionId(reconnected.sessionId);
    } catch (error) {
      onError(error);
    }
  };

  const confirmClose = async () => {
    if (!closeTarget) return;
    const target = closeTarget;
    try {
      await api.closeTerminal({ sessionId: target.sessionId, generation: target.generation });
      controller.removeSession(target.sessionId);
      setActiveSessionId(nextActiveSession(sessions, target.sessionId));
      setCloseTarget(null);
    } catch (error) {
      onError(error);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.getModifierState("AltGraph")) return;
      const primary = platform === "macos" ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      if (!primary || event.altKey) return;
      const newTerminalShortcut = platform === "macos" ? key === "t" && !event.shiftKey : key === "t" && event.shiftKey;
      const closeTerminalShortcut = platform === "macos" ? key === "w" && !event.shiftKey : key === "w" && event.shiftKey;
      const filesShortcut = platform === "macos" ? key === "f" && !event.shiftKey : key === "f" && event.shiftKey;
      const nextTabShortcut = platform !== "macos" && key === "tab" && !event.shiftKey;
      const previousTabShortcut = platform !== "macos" && key === "tab" && event.shiftKey;
      const macPreviousTabShortcut = platform === "macos" && key === "[" && event.shiftKey;
      const macNextTabShortcut = platform === "macos" && key === "]" && event.shiftKey;
      const appShortcut = newTerminalShortcut || closeTerminalShortcut || filesShortcut
        || nextTabShortcut || previousTabShortcut || macPreviousTabShortcut || macNextTabShortcut;
      if (isTerminalTarget(event.target) && !appShortcut) return;

      if (newTerminalShortcut) {
        event.preventDefault();
        void openTerminal(activeTerminal?.hostAlias ?? selectedHostAlias);
      } else if (closeTerminalShortcut && activeTerminal) {
        event.preventDefault();
        setCloseTarget(activeTerminal);
      } else if (macPreviousTabShortcut) {
        event.preventDefault();
        if (sessions.length > 0) {
          const index = Math.max(0, sessions.findIndex((session) => session.sessionId === activeSessionId));
          setActiveSessionId(sessions[(index - 1 + sessions.length) % sessions.length]?.sessionId ?? null);
        }
      } else if (macNextTabShortcut) {
        event.preventDefault();
        if (sessions.length > 0) {
          const index = Math.max(0, sessions.findIndex((session) => session.sessionId === activeSessionId));
          setActiveSessionId(sessions[(index + 1) % sessions.length]?.sessionId ?? null);
        }
      } else if (nextTabShortcut) {
        event.preventDefault();
        if (sessions.length > 0) {
          const index = Math.max(0, sessions.findIndex((session) => session.sessionId === activeSessionId));
          setActiveSessionId(sessions[(index + 1) % sessions.length]?.sessionId ?? null);
        }
      } else if (previousTabShortcut) {
        event.preventDefault();
        if (sessions.length > 0) {
          const index = Math.max(0, sessions.findIndex((session) => session.sessionId === activeSessionId));
          setActiveSessionId(sessions[(index - 1 + sessions.length) % sessions.length]?.sessionId ?? null);
        }
      } else if (filesShortcut) {
        event.preventDefault();
        chooseMode(mode === "terminal" ? "files" : mode);
        document.dispatchEvent(new Event(WORKSPACE_FILES_LOCATION_EVENT));
      } else if (key === "l" && !isEditableTarget(event.target)) {
        event.preventDefault();
        document.dispatchEvent(new CustomEvent("codexhub:workspace-terminal-focus", {
          detail: { sessionId: activeSessionId }
        }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSessionId, activeTerminal, mode, platform, selectedHostAlias, sessions]);

  const onSplitterKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      setSplitRatio((value) => Math.max(35, value - 5));
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      setSplitRatio((value) => Math.min(75, value + 5));
    }
    if (event.key === "Home") { event.preventDefault(); setSplitRatio(35); }
    if (event.key === "End") { event.preventDefault(); setSplitRatio(75); }
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = splitRef.current;
    if (!container) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      setSplitRatio(Math.max(35, Math.min(75, ((moveEvent.clientX - rect.left) / rect.width) * 100)));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  const terminalPanel = (
    <TerminalPanel
      activeSessionId={activeSessionId}
      api={api}
      copy={copy}
      hosts={hosts}
      platform={platform}
      preferences={terminalPreferences}
      sessions={sessions}
      onActivateSession={setActiveSessionId}
      onCloseSession={setCloseTarget}
      onError={onError}
      onHostSelected={(hostAlias) => void openTerminal(hostAlias)}
      onReconnect={(session) => void reconnect(session)}
    />
  );
  const filesPanel = (
    <FilesPanel
      activeTerminal={activeTerminal}
      api={api}
      copy={copy}
      cwd={cwd}
      followCwd={followCwd}
      hosts={hosts}
      isActive={mode === "files" || mode === "split"}
      selectedHostAlias={selectedHostAlias}
      onError={onError}
      onFollowCwdChange={setFollowCwd}
      onHostSelected={setSelectedHostAlias}
      onOpenTerminalAt={(hostAlias, fileSessionId, path) => void openTerminal(hostAlias, { fileSessionId, path })}
      onRecoveryCreated={controller.upsertRecovery}
      onViewRecoveries={() => chooseMode("transfers")}
      onTransfersQueued={() => void controller.reload().catch(onError)}
    />
  );

  return (
    <section className={`workspacePage${className ? ` ${className}` : ""}`} aria-label={copy.title}>
      <header className="workspacePageHeader">
        <div><h1>{copy.title}</h1><p>{copy.description}</p></div>
        <div
          className="workspaceModeBar"
          role="tablist"
          aria-label={copy.title}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") { event.preventDefault(); selectRelativeMode(-1); }
            if (event.key === "ArrowRight") { event.preventDefault(); selectRelativeMode(1); }
            if (event.key === "Home") { event.preventDefault(); selectModeAndFocus(WORKSPACE_MODES[0]); }
            if (event.key === "End") { event.preventDefault(); selectModeAndFocus(WORKSPACE_MODES[WORKSPACE_MODES.length - 1]); }
          }}
        >
          {WORKSPACE_MODES.map((entry) => (
            <button
              aria-controls="workspace-mode-content"
              aria-selected={mode === entry}
              key={entry}
              ref={(node) => {
                if (node) modeTabRefs.current.set(entry, node);
                else modeTabRefs.current.delete(entry);
              }}
              role="tab"
              tabIndex={mode === entry ? 0 : -1}
              type="button"
              onClick={() => chooseMode(entry)}
            >{copy.modes[entry]}</button>
          ))}
        </div>
      </header>

      <div
        ref={splitRef}
        className="workspacePageBody"
        data-mode={mode}
        id="workspace-mode-content"
        role="tabpanel"
        style={{ "--workspace-split-ratio": `${splitRatio}%` } as CSSProperties}
      >
        {/* Keep the live PTY and per-host SFTP state mounted across mode changes. */}
        <div className="workspaceModeTerminal" aria-hidden={mode === "files" || mode === "transfers"}>
          {terminalPanel}
        </div>
        <div
          aria-label="Resize workspace panes"
          aria-orientation="vertical"
          aria-valuemax={75}
          aria-valuemin={35}
          aria-valuenow={Math.round(splitRatio)}
          className="workspaceSplitHandle"
          role="separator"
          tabIndex={mode === "split" ? 0 : -1}
          onKeyDown={onSplitterKeyDown}
          onPointerDown={beginResize}
        />
        <div className="workspaceModeFiles" aria-hidden={mode === "terminal" || mode === "transfers"}>
          {filesPanel}
        </div>
        {mode === "transfers" ? (
          <TransfersPanel
            api={api}
            copy={copy}
            recoveries={controller.state.recoveries}
            localRecoveries={controller.state.localRecoveries}
            transfers={controller.state.transfers}
            onError={onError}
            onOpenTask={onOpenTask}
            onRecoveryUpdated={controller.upsertRecovery}
            onLocalRecoveryRemoved={controller.removeLocalRecovery}
            onLocalRecoveryUpdated={controller.upsertLocalRecovery}
          />
        ) : null}
      </div>

      {closeTarget ? (
        <div className="workspaceInlineDialogBackdrop" role="presentation">
          <section aria-describedby="workspace-close-terminal-body" aria-labelledby="workspace-close-terminal-title" className="workspaceInlineDialog" role="alertdialog" aria-modal="true">
            <h3 id="workspace-close-terminal-title">{copy.closeTerminalTitle}</h3>
            <p id="workspace-close-terminal-body">{copy.closeTerminalBody}</p>
            <div className="workspaceDialogActions">
              <button type="button" onClick={() => setCloseTarget(null)}>{copy.cancel}</button>
              <button className="workspaceDangerButton" type="button" onClick={() => void confirmClose()}>{copy.closeTerminal}</button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
