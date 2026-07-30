import { useEffect, useRef } from "react";
import type { WorkspaceCopy } from "./copy";
import type {
  WorkspaceApi,
  WorkspaceHost,
  WorkspacePlatform,
  WorkspaceTerminalPreferences,
  WorkspaceTerminalSession
} from "./types";
import { WORKSPACE_TERMINAL_SEARCH_EVENT, XtermTerminal } from "./XtermTerminal";
import type { TerminalRendererFailure } from "./XtermTerminal";

function stateLabel(state: WorkspaceTerminalSession["state"], copy: WorkspaceCopy) {
  switch (state) {
    case "creating":
    case "connecting": return copy.connecting;
    case "connected": return copy.connected;
    case "reconnecting": return copy.reconnecting;
    case "disconnected": return copy.disconnected;
    case "closing": return copy.closing;
    case "closed": return copy.closed;
    case "failed": return copy.failed;
  }
}

function cycleSession(sessions: WorkspaceTerminalSession[], activeSessionId: string | null, delta: number) {
  if (sessions.length === 0) return null;
  const currentIndex = Math.max(0, sessions.findIndex((session) => session.sessionId === activeSessionId));
  return sessions[(currentIndex + delta + sessions.length) % sessions.length].sessionId;
}

function hostOptionLabel(host: WorkspaceHost) {
  return host.name === host.hostAlias ? host.hostAlias : `${host.name} · ${host.hostAlias}`;
}

export function TerminalPanel({
  activeSessionId,
  api,
  copy,
  hosts,
  platform,
  preferences,
  sessions,
  onActivateSession,
  onCloseSession,
  onError,
  onRendererError,
  onHostSelected,
  onReconnect
}: {
  activeSessionId: string | null;
  api: WorkspaceApi;
  copy: WorkspaceCopy;
  hosts: WorkspaceHost[];
  platform: WorkspacePlatform;
  preferences: WorkspaceTerminalPreferences;
  sessions: WorkspaceTerminalSession[];
  onActivateSession: (sessionId: string) => void;
  onCloseSession: (session: WorkspaceTerminalSession) => void;
  onError: (error: unknown) => void;
  onRendererError: (failure: TerminalRendererFailure) => void;
  onHostSelected: (hostAlias: string) => void;
  onReconnect: (session: WorkspaceTerminalSession) => void;
}) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeSession = sessions.find((session) => session.sessionId === activeSessionId) ?? null;

  useEffect(() => {
    if (!activeSessionId && sessions.length > 0) onActivateSession(sessions[0].sessionId);
  }, [activeSessionId, onActivateSession, sessions]);

  const selectRelativeTab = (delta: number) => {
    const next = cycleSession(sessions, activeSessionId, delta);
    if (!next) return;
    onActivateSession(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <section className="workspaceTerminalPanel" aria-label={copy.modes.terminal}>
      <div className="workspacePaneToolbar workspaceTerminalToolbar">
        <label>
          <span>{copy.host}</span>
          <select value={activeSession?.hostAlias ?? ""} onChange={(event) => {
            if (event.target.value) onHostSelected(event.target.value);
          }}>
            <option value="">{copy.selectHost}</option>
            {hosts.map((host) => <option key={host.id} value={host.hostAlias}>{hostOptionLabel(host)}</option>)}
          </select>
        </label>
        <button type="button" disabled={hosts.length === 0} onClick={() => {
          const hostAlias = activeSession?.hostAlias ?? hosts[0]?.hostAlias;
          if (hostAlias) onHostSelected(hostAlias);
        }}>＋ {copy.newTerminal}</button>
        {activeSession?.reconnectable && ["disconnected", "failed", "closed"].includes(activeSession.state) ? (
          <button type="button" onClick={() => onReconnect(activeSession)}>↻ {copy.reconnect}</button>
        ) : null}
        {activeSession ? (
          <button
            aria-label={copy.searchTerminal}
            title={copy.searchTerminal}
            type="button"
            onClick={() => document.dispatchEvent(new CustomEvent(WORKSPACE_TERMINAL_SEARCH_EVENT, { detail: { sessionId: activeSession.sessionId } }))}
          >⌕</button>
        ) : null}
      </div>

      {sessions.length > 0 ? (
        <div
          className="workspaceTerminalTabs"
          role="tablist"
          aria-label={copy.terminalTabs}
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
            return (
              <div className="workspaceTerminalTab" data-active={active} key={session.sessionId}>
                <button
                  aria-controls={`workspace-terminal-${session.sessionId}`}
                  aria-selected={active}
                  ref={(node) => {
                    if (node) tabRefs.current.set(session.sessionId, node);
                    else tabRefs.current.delete(session.sessionId);
                  }}
                  role="tab"
                  tabIndex={active ? 0 : -1}
                  type="button"
                  onClick={() => onActivateSession(session.sessionId)}
                >
                  <span className="workspaceConnectionDot" data-state={session.state} aria-hidden="true" />
                  <span>{session.title || session.hostAlias}</span>
                  {session.title && session.title !== session.hostAlias ? <small>{session.hostAlias}</small> : null}
                </button>
                <button aria-label={`${copy.closeTerminal}: ${session.title}`} title={copy.closeTerminal} type="button" onClick={() => onCloseSession(session)}>×</button>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="workspaceTerminalStage">
        {sessions.length === 0 ? (
          <div className="workspaceEmptyState">
            <span aria-hidden="true">⌘</span>
            <p>{hosts.length === 0 ? copy.noHosts : copy.noTerminal}</p>
          </div>
        ) : sessions.map((session) => (
          <div
            className="workspaceTerminalInstance"
            data-active={session.sessionId === activeSessionId}
            id={`workspace-terminal-${session.sessionId}`}
            key={session.sessionId}
            role="tabpanel"
          >
            <XtermTerminal
              active={session.sessionId === activeSessionId}
              api={api}
              copy={copy}
              platform={platform}
              preferences={preferences}
              session={session}
              onError={onError}
              onRendererError={onRendererError}
            />
          </div>
        ))}
      </div>

      {activeSession ? <span className="workspaceVisuallyHidden" aria-live="polite">{stateLabel(activeSession.state, copy)}</span> : null}
    </section>
  );
}
