import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { workspaceCopy } from "./copy";
import { useWorkspaceController } from "./controller";
import { FilesPanel, WORKSPACE_FILES_LOCATION_EVENT } from "./FilesPanel";
import { TerminalPanel } from "./TerminalPanel";
import { TransfersPanel } from "./TransfersPanel";
import type { TerminalRendererFailure } from "./XtermTerminal";
import type {
  WorkspaceApi,
  WorkspaceHost,
  WorkspaceLocale,
  WorkspaceMode,
  WorkspacePlatform,
  WorkspaceTerminalPreferences,
  WorkspaceTerminalHostRequest,
  WorkspaceTerminalSession
} from "./types";

const TERMINAL_COLUMNS = 120;
const TERMINAL_ROWS = 32;
const SPLIT_STACK_BREAKPOINT = 900;
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
  mode: controlledMode,
  hosts,
  initialHostAlias = "",
  locale,
  onError,
  onTerminalRendererError,
  onModeChange,
  onOpenTask,
  onSelectedHostChange,
  onTerminalHostRequestHandled,
  platform,
  selectedHostAlias: controlledHostAlias,
  terminalHostRequest,
  terminalPreferences
}: {
  api: WorkspaceApi;
  className?: string;
  defaultMode?: WorkspaceMode;
  mode?: WorkspaceMode;
  hosts: WorkspaceHost[];
  initialHostAlias?: string;
  locale: WorkspaceLocale;
  onError: (error: unknown) => void;
  onTerminalRendererError: (failure: TerminalRendererFailure) => void;
  onModeChange?: (mode: WorkspaceMode) => void;
  onOpenTask?: (taskId: string) => void;
  onSelectedHostChange?: (hostAlias: string) => void;
  onTerminalHostRequestHandled?: (requestId: number) => void;
  platform: WorkspacePlatform;
  selectedHostAlias?: string;
  terminalHostRequest?: WorkspaceTerminalHostRequest | null;
  terminalPreferences: WorkspaceTerminalPreferences;
}) {
  const copy = workspaceCopy[locale];
  const controller = useWorkspaceController(api, onError);
  const [internalMode, setInternalMode] = useState<WorkspaceMode>(defaultMode);
  const mode = controlledMode ?? internalMode;
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [internalHostAlias, setInternalHostAlias] = useState(initialHostAlias);
  const selectedHostAlias = controlledHostAlias ?? internalHostAlias;
  const [followCwd, setFollowCwd] = useState(true);
  const [splitRatio, setSplitRatio] = useState(40);
  const [isStackedSplit, setIsStackedSplit] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const consumedTerminalHostRequestIdRef = useRef<number | null>(null);
  const latestTerminalHostRequestIdRef = useRef(0);

  const sessions = useMemo(
    () => controller.state.sessions.filter((session) => session.state !== "closed"),
    [controller.state.sessions]
  );
  const activeTerminal = sessions.find((session) => session.sessionId === activeSessionId) ?? null;
  const cwd = activeTerminal ? controller.state.cwdBySession[activeTerminal.sessionId] ?? null : null;

  useEffect(() => {
    const container = splitRef.current;
    if (!container || mode !== "split") {
      setIsStackedSplit(false);
      return;
    }

    // Split behavior follows the usable Workspace width, which may be narrower than the window.
    const updateSplitLayout = () => {
      const width = container.getBoundingClientRect().width;
      setIsStackedSplit(width > 0 && width < SPLIT_STACK_BREAKPOINT);
    };

    updateSplitLayout();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSplitLayout);
      return () => window.removeEventListener("resize", updateSplitLayout);
    }

    const observer = new ResizeObserver(updateSplitLayout);
    observer.observe(container);
    return () => observer.disconnect();
  }, [mode]);

  const chooseMode = useCallback((next: WorkspaceMode) => {
    setInternalMode(next);
    onModeChange?.(next);
  }, [onModeChange]);

  const selectHost = useCallback((hostAlias: string) => {
    setInternalHostAlias(hostAlias);
    onSelectedHostChange?.(hostAlias);
  }, [onSelectedHostChange]);

  /** Keeps the selected app host aligned with the PTY receiving terminal input. */
  const activateTerminal = useCallback((sessionId: string, knownSession?: WorkspaceTerminalSession) => {
    const session = knownSession ?? sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session) return;
    setActiveSessionId(sessionId);
    if (mode === "terminal" || mode === "split") selectHost(session.hostAlias);
    if (mode === "split") setFollowCwd(true);
  }, [mode, selectHost, sessions]);

  useEffect(() => {
    if (activeSessionId && sessions.some((session) => session.sessionId === activeSessionId)) return;
    const fallbackSession = sessions[sessions.length - 1];
    if (fallbackSession) activateTerminal(fallbackSession.sessionId);
    else setActiveSessionId(null);
  }, [activeSessionId, activateTerminal, sessions]);

  const openTerminal = useCallback(async (
    hostAlias: string,
    initialDirectory?: { fileSessionId: string; path: string },
    terminalHostRequestId?: number
  ) => {
    const isCurrentHostRequest = () => terminalHostRequestId === undefined
      || latestTerminalHostRequestIdRef.current === terminalHostRequestId;
    if (!hostAlias || !isCurrentHostRequest()) return;
    selectHost(hostAlias);
    const keepSplit = mode === "split";
    try {
      const existing = sessions.find((session) => session.hostAlias === hostAlias && session.state !== "closing");
      if (!initialDirectory && existing) {
        if (!isCurrentHostRequest()) return;
        activateTerminal(existing.sessionId);
        chooseMode(keepSplit ? "split" : "terminal");
        return;
      }
      const session = await api.openTerminal({
        hostAlias,
        columns: TERMINAL_COLUMNS,
        rows: TERMINAL_ROWS,
        initialDirectory: initialDirectory ?? null
      });
      controller.upsertSession(session);
      if (!isCurrentHostRequest()) return;
      activateTerminal(session.sessionId, session);
      chooseMode(keepSplit ? "split" : "terminal");
    } catch (error) {
      onError(error);
    }
  }, [activateTerminal, api, chooseMode, controller, mode, onError, selectHost, sessions]);

  useEffect(() => {
    if (mode !== "terminal" && mode !== "split") return;
    if (!terminalHostRequest || consumedTerminalHostRequestIdRef.current === terminalHostRequest.requestId) return;
    consumedTerminalHostRequestIdRef.current = terminalHostRequest.requestId;
    latestTerminalHostRequestIdRef.current = terminalHostRequest.requestId;
    onTerminalHostRequestHandled?.(terminalHostRequest.requestId);

    const currentSession = sessions.find((session) => (
      session.hostAlias === terminalHostRequest.hostAlias && session.state !== "closing"
    ));
    if (currentSession) {
      activateTerminal(currentSession.sessionId);
      return;
    }

    // The Workspace may have just mounted, before its controller has restored sessions.
    // Read the backend snapshot once so an existing PTY is activated rather than duplicated.
    void (async () => {
      try {
        const snapshot = await api.listTerminalSessions();
        if (latestTerminalHostRequestIdRef.current !== terminalHostRequest.requestId) return;
        const existing = snapshot.find((session) => (
          session.hostAlias === terminalHostRequest.hostAlias
          && session.state !== "closed"
          && session.state !== "closing"
        ));
        if (existing) {
          controller.upsertSession(existing);
          activateTerminal(existing.sessionId, existing);
          return;
        }
        await openTerminal(terminalHostRequest.hostAlias, undefined, terminalHostRequest.requestId);
      } catch (error) {
        if (latestTerminalHostRequestIdRef.current === terminalHostRequest.requestId) onError(error);
      }
    })();
  }, [activateTerminal, api, controller, mode, onError, onTerminalHostRequestHandled, openTerminal, sessions, terminalHostRequest]);

  useEffect(() => {
    if (mode !== "split" || !activeTerminal) return;
    selectHost(activeTerminal.hostAlias);
    setFollowCwd(true);
  }, [activeTerminal?.hostAlias, activeTerminal?.sessionId, mode, selectHost]);

  const reconnect = async (session: WorkspaceTerminalSession) => {
    try {
      const reconnected = await api.reconnectTerminal({ sessionId: session.sessionId });
      controller.upsertSession(reconnected);
      activateTerminal(reconnected.sessionId, reconnected);
    } catch (error) {
      onError(error);
    }
  };

  const closeTerminal = async (target: WorkspaceTerminalSession) => {
    try {
      await api.closeTerminal({ sessionId: target.sessionId, generation: target.generation });
      controller.removeSession(target.sessionId);
      if (target.sessionId !== activeSessionId) return;
      const nextSessionId = nextActiveSession(sessions, target.sessionId);
      if (nextSessionId) activateTerminal(nextSessionId);
      else setActiveSessionId(null);
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
        void closeTerminal(activeTerminal);
        } else if (macPreviousTabShortcut) {
          event.preventDefault();
          if (sessions.length > 0) {
            const index = Math.max(0, sessions.findIndex((session) => session.sessionId === activeSessionId));
            const next = sessions[(index - 1 + sessions.length) % sessions.length];
            if (next) activateTerminal(next.sessionId);
          }
        } else if (macNextTabShortcut) {
          event.preventDefault();
          if (sessions.length > 0) {
            const index = Math.max(0, sessions.findIndex((session) => session.sessionId === activeSessionId));
            const next = sessions[(index + 1) % sessions.length];
            if (next) activateTerminal(next.sessionId);
          }
        } else if (nextTabShortcut) {
          event.preventDefault();
          if (sessions.length > 0) {
            const index = Math.max(0, sessions.findIndex((session) => session.sessionId === activeSessionId));
            const next = sessions[(index + 1) % sessions.length];
            if (next) activateTerminal(next.sessionId);
          }
        } else if (previousTabShortcut) {
          event.preventDefault();
          if (sessions.length > 0) {
            const index = Math.max(0, sessions.findIndex((session) => session.sessionId === activeSessionId));
            const next = sessions[(index - 1 + sessions.length) % sessions.length];
            if (next) activateTerminal(next.sessionId);
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
  }, [activateTerminal, activeSessionId, activeTerminal, mode, openTerminal, platform, selectedHostAlias, sessions]);

  const onSplitterKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const decreaseKey = isStackedSplit ? "ArrowUp" : "ArrowLeft";
    const increaseKey = isStackedSplit ? "ArrowDown" : "ArrowRight";
    if (event.key === decreaseKey) {
      event.preventDefault();
      setSplitRatio((value) => Math.max(35, value - 5));
    }
    if (event.key === increaseKey) {
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
      const size = isStackedSplit ? rect.height : rect.width;
      const offset = isStackedSplit ? moveEvent.clientY - rect.top : moveEvent.clientX - rect.left;
      if (size <= 0) return;
      setSplitRatio(Math.max(35, Math.min(75, (offset / size) * 100)));
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
      locale={locale}
      platform={platform}
      preferences={terminalPreferences}
      sessions={sessions}
      selectedHostAlias={selectedHostAlias}
      onActivateSession={activateTerminal}
      onCloseSession={(session) => void closeTerminal(session)}
      onError={onError}
      onRendererError={onTerminalRendererError}
      onHostSelected={(hostAlias) => void openTerminal(hostAlias)}
      isFilesSplit={mode === "split"}
      onToggleFilesSplit={() => chooseMode(mode === "split" ? "terminal" : "split")}
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
      compact={mode === "split"}
      locale={locale}
      selectedHostAlias={selectedHostAlias}
      onError={onError}
      onFollowCwdChange={setFollowCwd}
      onHostSelected={selectHost}
      onOpenTerminalAt={(hostAlias, fileSessionId, path) => void openTerminal(hostAlias, { fileSessionId, path })}
      onRecoveryCreated={controller.upsertRecovery}
      onViewRecoveries={() => chooseMode("transfers")}
      onTransfersQueued={() => void controller.reload().catch(onError)}
    />
  );

  return (
    <section className={`workspacePage${className ? ` ${className}` : ""}`} aria-label={copy.title}>
      <div
        ref={splitRef}
        className="workspacePageBody"
        data-mode={mode}
        data-split-layout={mode === "split" ? (isStackedSplit ? "stacked" : "side-by-side") : undefined}
        id="workspace-mode-content"
        role="tabpanel"
        style={{ "--workspace-split-ratio": `${splitRatio}%` } as CSSProperties}
      >
        {/* Files stay left and Terminal stays right in Split, while both remain mounted across mode changes. */}
        <div className="workspaceModeFiles" aria-hidden={mode === "terminal" || mode === "transfers"}>
          {filesPanel}
        </div>
        <div
          aria-label={copy.resizeWorkspacePanes}
          aria-orientation={isStackedSplit ? "horizontal" : "vertical"}
          aria-valuemax={75}
          aria-valuemin={35}
          aria-valuenow={Math.round(splitRatio)}
          className="workspaceSplitHandle"
          role="separator"
          tabIndex={mode === "split" ? 0 : -1}
          onKeyDown={onSplitterKeyDown}
          onPointerDown={beginResize}
        />
        <div className="workspaceModeTerminal" aria-hidden={mode === "files" || mode === "transfers"}>
          {terminalPanel}
        </div>
        {mode === "transfers" ? (
          <TransfersPanel
            api={api}
            copy={copy}
            locale={locale}
            recoveries={controller.state.recoveries}
            localRecoveries={controller.state.localRecoveries}
            transfers={controller.state.transfers}
            onError={onError}
            onNewTransfer={() => chooseMode("files")}
            onOpenTask={onOpenTask}
            onRefresh={controller.reload}
            onRecoveryUpdated={controller.upsertRecovery}
            onLocalRecoveryRemoved={controller.removeLocalRecovery}
            onLocalRecoveryUpdated={controller.upsertLocalRecovery}
          />
        ) : null}
      </div>

    </section>
  );
}
