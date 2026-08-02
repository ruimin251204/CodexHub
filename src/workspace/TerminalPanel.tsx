import { useEffect, useRef, useState } from "react";
import { ActionButton } from "../components/UI/ActionButton";
import type { ActionButtonProps } from "../components/UI/ActionButton";
import { usePersonalInfoMasking } from "../ui/PersonalInfoMasking";
import "./terminal-redesign.css";
import type { WorkspaceCopy } from "./copy";
import { workspaceHostLabel } from "./hostLabel";
import { terminalUiCopy } from "./terminal/copy";
import { TerminalIcon } from "./terminal/TerminalIcon";
import type { TerminalIconName } from "./terminal/TerminalIcon";
import { TerminalStatusBar } from "./terminal/TerminalStatusBar";
import type {
  WorkspaceApi,
  WorkspaceHost,
  WorkspaceLocale,
  WorkspacePlatform,
  WorkspaceTerminalPreferences,
  WorkspaceTerminalSession
} from "./types";
import {
  WORKSPACE_TERMINAL_FOCUS_EVENT,
  XtermTerminal
} from "./XtermTerminal";
import type { TerminalRendererFailure, TerminalThemeOverride } from "./XtermTerminal";

function cycleSession(sessions: WorkspaceTerminalSession[], activeSessionId: string | null, delta: number) {
  if (sessions.length === 0) return null;
  const currentIndex = Math.max(0, sessions.findIndex((session) => session.sessionId === activeSessionId));
  return sessions[(currentIndex + delta + sessions.length) % sessions.length].sessionId;
}

function canReconnect(session: WorkspaceTerminalSession | null) {
  return Boolean(
    session?.reconnectable
    && ["disconnected", "failed", "closed"].includes(session.state)
  );
}

function dispatchTerminalEvent(name: string, sessionId: string) {
  document.dispatchEvent(new CustomEvent(name, { detail: { sessionId } }));
}

function TerminalActionButton({
  icon,
  label,
  labelMode = "responsive",
  ...props
}: {
  icon: TerminalIconName;
  label: string;
  labelMode?: "always" | "responsive" | "hidden";
} & Omit<ActionButtonProps, "children" | "icon">) {
  return (
    <ActionButton
      {...props}
      aria-label={props["aria-label"] ?? label}
      icon={<TerminalIcon name={icon} />}
      size="sm"
      title={props.title ?? label}
    >
      {labelMode === "hidden"
        ? <span className="workspaceVisuallyHidden">{label}</span>
        : <span data-label-mode={labelMode}>{label}</span>}
    </ActionButton>
  );
}

export function TerminalPanel({
  activeSessionId,
  api,
  copy,
  hosts,
  locale,
  platform,
  preferences,
  selectedHostAlias,
  sessions,
  onActivateSession,
  onCloseSession,
  onError,
  onRendererError,
  onHostSelected,
  onReconnect,
  isFilesSplit,
  onRequestFilesSplit,
  onToggleFilesSplit
}: {
  activeSessionId: string | null;
  api: WorkspaceApi;
  copy: WorkspaceCopy;
  hosts: WorkspaceHost[];
  locale?: WorkspaceLocale;
  platform: WorkspacePlatform;
  preferences: WorkspaceTerminalPreferences;
  selectedHostAlias?: string;
  sessions: WorkspaceTerminalSession[];
  onActivateSession: (sessionId: string) => void;
  onCloseSession: (session: WorkspaceTerminalSession) => void;
  onError: (error: unknown) => void;
  onRendererError: (failure: TerminalRendererFailure) => void;
  onHostSelected: (hostAlias: string) => void;
  onReconnect: (session: WorkspaceTerminalSession) => void;
  /** Whether Workspace is showing its Files + Terminal split. */
  isFilesSplit: boolean;
  /** @deprecated Prefer onToggleFilesSplit so the parent can also close the split. */
  onRequestFilesSplit?: () => void;
  /** Toggles Workspace's Files + Terminal split; layout ownership stays with WorkspacePage. */
  onToggleFilesSplit?: () => void;
}) {
  const resolvedLocale = locale ?? "en";
  const ui = terminalUiCopy[resolvedLocale];
  const personalInfo = usePersonalInfoMasking();
  const rootRef = useRef<HTMLElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const themeMenuRef = useRef<HTMLDetailsElement>(null);
  const hostPickerRef = useRef<HTMLDivElement>(null);
  const hostPickerTriggerRef = useRef<HTMLElement | null>(null);
  const [isHostPickerOpen, setIsHostPickerOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // The persisted terminal preference defaults to dark and never follows the app theme.
  const [themeOverride, setThemeOverride] = useState<TerminalThemeOverride>("preferences");

  const activeSession = sessions.find((session) => session.sessionId === activeSessionId) ?? null;
  const focusedSession = activeSession;
  const toggleFilesSplit = onToggleFilesSplit ?? onRequestFilesSplit;
  const resolvedThemeMode = themeOverride === "preferences"
    ? (preferences.colorScheme === "light" || preferences.colorScheme === "high-contrast" ? preferences.colorScheme : "dark")
    : themeOverride;

  useEffect(() => {
    if (!activeSessionId && sessions.length > 0) onActivateSession(sessions[0].sessionId);
  }, [activeSessionId, onActivateSession, sessions]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    const closeThemeMenu = (event: PointerEvent) => {
      const menu = themeMenuRef.current;
      const target = event.target;
      if (!menu?.open || !(target instanceof Node) || menu.contains(target)) return;
      menu.open = false;
    };
    const closeThemeMenuOnEscape = (event: KeyboardEvent) => {
      const menu = themeMenuRef.current;
      if (event.key !== "Escape" || !menu?.open) return;
      event.preventDefault();
      menu.open = false;
      menu.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeThemeMenu);
    document.addEventListener("keydown", closeThemeMenuOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeThemeMenu);
      document.removeEventListener("keydown", closeThemeMenuOnEscape);
    };
  }, []);

  useEffect(() => {
    if (!isHostPickerOpen) return;
    const frame = window.requestAnimationFrame(() => hostPickerRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setIsHostPickerOpen(false);
      window.setTimeout(() => hostPickerTriggerRef.current?.focus(), 0);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isHostPickerOpen]);

  const closeHostPicker = () => {
    setIsHostPickerOpen(false);
    window.setTimeout(() => hostPickerTriggerRef.current?.focus(), 0);
  };

  const openHostPicker = (trigger: HTMLElement) => {
    if (hosts.length === 0) return;
    hostPickerTriggerRef.current = trigger;
    setIsHostPickerOpen(true);
  };

  const chooseHost = (hostAlias: string) => {
    closeHostPicker();
    onHostSelected(hostAlias);
  };

  const selectRelativeTab = (delta: number) => {
    const next = cycleSession(sessions, activeSessionId, delta);
    if (!next) return;
    onActivateSession(next);
    tabRefs.current.get(next)?.focus();
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === rootRef.current) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch (error) {
      onError(error);
    }
  };

  const setTheme = (theme: TerminalThemeOverride) => {
    setThemeOverride(theme);
    if (themeMenuRef.current) themeMenuRef.current.open = false;
    if (activeSessionId) window.setTimeout(() => dispatchTerminalEvent(WORKSPACE_TERMINAL_FOCUS_EVENT, activeSessionId), 0);
  };

  const themeOptions: Array<{ value: TerminalThemeOverride; label: string }> = [
    { value: "preferences", label: ui.themePreference },
    { value: "dark", label: ui.themeDark },
    { value: "light", label: ui.themeLight },
    { value: "high-contrast", label: ui.themeContrast }
  ];

  return (
    <section
      aria-label={copy.modes.terminal}
      className="workspaceTerminalPanel chTerminal"
      data-fullscreen={isFullscreen}
      data-terminal-theme={resolvedThemeMode}
      ref={rootRef}
    >
      <header aria-label={ui.toolbar} className="chTerminalToolbar">
        {sessions.length > 0 ? (
          <div
            aria-label={copy.terminalTabs}
            className="workspaceTerminalTabs chTerminalTabs"
            role="tablist"
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") { event.preventDefault(); selectRelativeTab(1); }
              if (event.key === "ArrowLeft") { event.preventDefault(); selectRelativeTab(-1); }
              if (event.key === "Home" && sessions[0]) {
                event.preventDefault();
                onActivateSession(sessions[0].sessionId);
                tabRefs.current.get(sessions[0].sessionId)?.focus();
              }
              const last = sessions[sessions.length - 1];
              if (event.key === "End" && last) {
                event.preventDefault();
                onActivateSession(last.sessionId);
                tabRefs.current.get(last.sessionId)?.focus();
              }
            }}
          >
            {sessions.map((session) => {
              const active = session.sessionId === activeSessionId;
              const displayAlias = personalInfo.maskText(session.hostAlias || session.title);
              return (
                <div
                  className="workspaceTerminalTab chTerminalTab"
                  data-active={active}
                  key={session.sessionId}
                >
                  <button
                    aria-controls={`workspace-terminal-${session.sessionId}`}
                    aria-selected={active}
                    id={`terminal-tab-${session.sessionId}`}
                    ref={(node) => {
                      if (node) tabRefs.current.set(session.sessionId, node);
                      else tabRefs.current.delete(session.sessionId);
                    }}
                    role="tab"
                    tabIndex={active ? 0 : -1}
                    title={displayAlias}
                    type="button"
                    onClick={() => onActivateSession(session.sessionId)}
                  >
                    <span className="workspaceConnectionDot" data-state={session.state} aria-hidden="true" />
                    <span>{displayAlias}</span>
                  </button>
                  <button
                    aria-label={`${copy.closeTerminal}: ${displayAlias}`}
                    title={copy.closeTerminal}
                    type="button"
                    onClick={() => onCloseSession(session)}
                  ><TerminalIcon name="close" size={13} /></button>
                </div>
              );
            })}
            <button
              aria-label={ui.newTerminal}
              className="chTerminalTabAdd"
              disabled={hosts.length === 0}
              title={ui.newTerminal}
              type="button"
              onClick={(event) => openHostPicker(event.currentTarget)}
            ><TerminalIcon name="plus" /></button>
          </div>
        ) : <div className="chTerminalToolbarTabsPlaceholder" aria-hidden="true" />}
        <div className="chTerminalActionGroup">
          <TerminalActionButton
            aria-pressed={isFilesSplit}
            disabled={sessions.length === 0 || !toggleFilesSplit}
            icon="split"
            label={isFilesSplit ? ui.exitSplit : ui.split}
            onClick={toggleFilesSplit}
          />
          <TerminalActionButton
            icon={isFullscreen ? "contract" : "expand"}
            label={isFullscreen ? ui.exitFullscreen : ui.fullscreen}
            onClick={() => void toggleFullscreen()}
          />
          <TerminalActionButton
            disabled={!canReconnect(activeSession)}
            icon="reconnect"
            label={ui.reconnect}
            onClick={() => {
              if (activeSession && canReconnect(activeSession)) onReconnect(activeSession);
            }}
          />

          <details className="chTerminalMenu" ref={themeMenuRef}>
            <summary aria-label={ui.theme} title={ui.theme}>
              <TerminalIcon name="theme" />
              <span data-label-mode="responsive">{ui.theme}</span>
              <TerminalIcon name="chevron" size={13} />
            </summary>
            <div className="chTerminalMenuPopover" role="menu" aria-label={ui.theme}>
              {themeOptions.map((option) => (
                <button
                  aria-checked={themeOverride === option.value}
                  data-selected={themeOverride === option.value}
                  key={option.value}
                  role="menuitemradio"
                  type="button"
                  onClick={() => setTheme(option.value)}
                >
                  <span>{option.label}</span>
                  {themeOverride === option.value ? <span aria-hidden="true">✓</span> : null}
                </button>
              ))}
            </div>
          </details>
        </div>
      </header>

      <div className="workspaceTerminalStage chTerminalStage">
        {sessions.length === 0 ? (
          <div className="workspaceEmptyState chTerminalEmptyState">
            <TerminalIcon name="terminal" size={24} />
            <p>{hosts.length === 0 ? copy.noHosts : copy.noTerminal}</p>
            <TerminalActionButton
              className="chTerminalPrimaryAction"
              disabled={hosts.length === 0}
              icon="plus"
              label={ui.newTerminal}
              labelMode="always"
              onClick={(event) => openHostPicker(event.currentTarget)}
            />
          </div>
        ) : sessions.map((session) => {
          const active = session.sessionId === activeSessionId;
          return (
            <div
              aria-hidden={!active}
              aria-labelledby={`terminal-tab-${session.sessionId}`}
              className="workspaceTerminalInstance chTerminalInstance"
              data-focused={active}
              data-visible={active}
              id={`workspace-terminal-${session.sessionId}`}
              key={session.sessionId}
              role="tabpanel"
              onPointerDown={() => onActivateSession(session.sessionId)}
            >
              <XtermTerminal
                active={active}
                api={api}
                copy={copy}
                platform={platform}
                preferences={preferences}
                session={session}
                themeOverride={themeOverride}
                onError={onError}
                onRendererError={onRendererError}
              />
              {active ? <TerminalStatusBar copy={ui} session={session} /> : null}
            </div>
          );
        })}
      </div>

      {isHostPickerOpen ? (
        <div className="chTerminalHostPickerBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) closeHostPicker();
        }}>
          <section
            aria-describedby="ch-terminal-host-picker-description"
            aria-labelledby="ch-terminal-host-picker-title"
            aria-modal="true"
            className="chTerminalHostPickerDialog"
            ref={hostPickerRef}
            role="dialog"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)"));
              if (focusable.length === 0) return;
              const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
              const nextIndex = event.shiftKey
                ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
                : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
              event.preventDefault();
              focusable[nextIndex]?.focus();
            }}
          >
            <header>
              <div>
                <h2 id="ch-terminal-host-picker-title">{ui.hostPickerTitle}</h2>
                <p id="ch-terminal-host-picker-description">{ui.hostPickerDescription}</p>
              </div>
              <button aria-label={ui.closeHostPicker} title={ui.closeHostPicker} type="button" onClick={closeHostPicker}>
                <TerminalIcon name="close" />
              </button>
            </header>
            <div className="chTerminalHostPickerList">
              {hosts.map((host) => (
                <button
                  className="chTerminalHostPickerOption"
                  data-preferred={host.hostAlias === (selectedHostAlias ?? focusedSession?.hostAlias) || undefined}
                  key={host.id}
                  type="button"
                  onClick={() => chooseHost(host.hostAlias)}
                >
                  <span className="chTerminalStateDot" data-state={host.status === "online" ? "connected" : host.status} aria-hidden="true" />
                  <span>{personalInfo.maskText(workspaceHostLabel(host))}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {activeSession ? (
        <span className="workspaceVisuallyHidden" aria-live="polite">{ui.states[activeSession.state]}</span>
      ) : null}
    </section>
  );
}
