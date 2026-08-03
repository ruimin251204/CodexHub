import type {
  WorkspaceRecovery,
  WorkspaceLocalTransferRecovery,
  WorkspaceSessionHeartbeatEvent,
  WorkspaceSessionStateEvent,
  WorkspaceTerminalCwdEvent,
  WorkspaceTerminalSession,
  WorkspaceTransfer,
  WorkspaceTransferSnapshot,
  WorkspaceTransferUpdatedEvent
} from "./types";

export type WorkspaceState = {
  sessionsLoaded: boolean;
  sessions: WorkspaceTerminalSession[];
  transfers: WorkspaceTransfer[];
  recoveries: WorkspaceRecovery[];
  localRecoveries: WorkspaceLocalTransferRecovery[];
  cwdBySession: Record<string, WorkspaceTerminalCwdEvent>;
  heartbeatBySession: Record<string, WorkspaceSessionHeartbeatEvent>;
};

export type WorkspaceStateAction =
  | { type: "sessions-loaded"; sessions: WorkspaceTerminalSession[] }
  | { type: "session-upserted"; session: WorkspaceTerminalSession }
  | { type: "session-state-received"; event: WorkspaceSessionStateEvent }
  | { type: "session-removed"; sessionId: string }
  | { type: "session-cwd-received"; event: WorkspaceTerminalCwdEvent }
  | { type: "session-heartbeat-received"; event: WorkspaceSessionHeartbeatEvent }
  | { type: "transfers-loaded"; snapshot: WorkspaceTransferSnapshot }
  | { type: "transfers-upserted"; transfers: WorkspaceTransfer[] }
  | { type: "transfer-received"; event: WorkspaceTransferUpdatedEvent }
  | { type: "recovery-upserted"; recovery: WorkspaceRecovery }
  | { type: "recovery-removed"; recoveryId: string }
  | { type: "local-recovery-upserted"; recovery: WorkspaceLocalTransferRecovery }
  | { type: "local-recovery-removed"; recoveryId: string };

export const initialWorkspaceState: WorkspaceState = {
  sessionsLoaded: false,
  sessions: [],
  transfers: [],
  recoveries: [],
  localRecoveries: [],
  cwdBySession: {},
  heartbeatBySession: {}
};

function compareSessions(left: WorkspaceTerminalSession, right: WorkspaceTerminalSession) {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.sessionId.localeCompare(right.sessionId);
}

export function upsertSession(
  sessions: WorkspaceTerminalSession[],
  incoming: WorkspaceTerminalSession
): WorkspaceTerminalSession[] {
  const current = sessions.find((session) => session.sessionId === incoming.sessionId);
  if (current && (
    current.generation > incoming.generation
    || (current.generation === incoming.generation && current.revision > incoming.revision)
  )) return sessions;
  return [...sessions.filter((session) => session.sessionId !== incoming.sessionId), incoming].sort(compareSessions);
}

export function applySessionStateEvent(
  sessions: WorkspaceTerminalSession[],
  event: WorkspaceSessionStateEvent
): WorkspaceTerminalSession[] {
  const current = sessions.find((session) => session.sessionId === event.sessionId);
  if (!current || current.generation > event.generation) return sessions;
  if (current.generation === event.generation && current.revision >= event.revision) return sessions;
  return sessions.map((session) => session.sessionId === event.sessionId
    ? {
        ...session,
        generation: event.generation,
        revision: event.revision,
        state: event.state,
        reconnectable: event.reconnectable,
        attempt: event.attempt,
        nextRetryAt: event.nextRetryAt,
        reason: event.reason,
        taskId: event.taskId
      }
    : session);
}

export function upsertTransfer(
  transfers: WorkspaceTransfer[],
  event: WorkspaceTransfer | WorkspaceTransferUpdatedEvent
): WorkspaceTransfer[] {
  const current = transfers.find((transfer) => transfer.transferId === event.transferId);
  if (current && current.revision >= event.revision) return transfers;
  if (!current) {
    // A partial event can race the initial snapshot. Wait for the authoritative
    // list instead of inventing labels or destination paths in the renderer.
    return isWorkspaceTransfer(event) ? [event, ...transfers] : transfers;
  }
  const next = {
    ...current,
    ...event,
    capabilities: transferCapabilities(event.state)
  };
  return [next, ...transfers.filter((transfer) => transfer.transferId !== event.transferId)];
}

function isWorkspaceTransfer(value: WorkspaceTransfer | WorkspaceTransferUpdatedEvent): value is WorkspaceTransfer {
  return "direction" in value && "capabilities" in value;
}

function transferCapabilities(state: WorkspaceTransfer["state"]): WorkspaceTransfer["capabilities"] {
  return {
    canPause: state === "queued" || state === "running" || state === "verifying",
    canResume: state === "paused" || state === "interrupted",
    canCancel: !["completed", "cancelled", "finalizing"].includes(state),
    canRetry: state === "failed" || state === "interrupted",
    canRestart: state === "failed" || state === "interrupted"
  };
}

function acceptSessionEvent<T extends { sessionId: string; generation: number; revision: number }>(
  current: T | undefined,
  event: T
) {
  if (!current) return true;
  if (current.generation > event.generation) return false;
  return current.generation < event.generation || current.revision < event.revision;
}

export function workspaceStateReducer(state: WorkspaceState, action: WorkspaceStateAction): WorkspaceState {
  switch (action.type) {
    case "sessions-loaded":
      // Events can arrive while the initial list request is in flight.  Merge
      // by generation/revision so an older snapshot can never roll state back.
      return {
        ...state,
        sessionsLoaded: true,
        sessions: action.sessions.reduce(
          (current, session) => upsertSession(current, session),
          state.sessions
        )
      };
    case "session-upserted":
      return { ...state, sessions: upsertSession(state.sessions, action.session) };
    case "session-state-received":
      return { ...state, sessions: applySessionStateEvent(state.sessions, action.event) };
    case "session-removed": {
      const { [action.sessionId]: _cwd, ...cwdBySession } = state.cwdBySession;
      const { [action.sessionId]: _heartbeat, ...heartbeatBySession } = state.heartbeatBySession;
      return {
        ...state,
        sessions: state.sessions.filter((session) => session.sessionId !== action.sessionId),
        cwdBySession,
        heartbeatBySession
      };
    }
    case "session-cwd-received": {
      const current = state.cwdBySession[action.event.sessionId];
      if (!acceptSessionEvent(current, action.event)) return state;
      return { ...state, cwdBySession: { ...state.cwdBySession, [action.event.sessionId]: action.event } };
    }
    case "session-heartbeat-received": {
      const current = state.heartbeatBySession[action.event.sessionId];
      if (!acceptSessionEvent(current, action.event)) return state;
      return { ...state, heartbeatBySession: { ...state.heartbeatBySession, [action.event.sessionId]: action.event } };
    }
    case "transfers-loaded":
      return {
        ...state,
        transfers: action.snapshot.transfers.reduce(
          (current, transfer) => upsertTransfer(current, transfer),
          state.transfers
        ),
        recoveries: action.snapshot.recoveries,
        localRecoveries: action.snapshot.localRecoveries
      };
    case "transfers-upserted":
      return {
        ...state,
        transfers: action.transfers.reduce(
          (current, transfer) => upsertTransfer(current, transfer),
          state.transfers
        )
      };
    case "transfer-received":
      return { ...state, transfers: upsertTransfer(state.transfers, action.event) };
    case "recovery-upserted":
      return {
        ...state,
        recoveries: [
          action.recovery,
          ...state.recoveries.filter((recovery) => recovery.recoveryId !== action.recovery.recoveryId)
        ]
      };
    case "recovery-removed":
      return { ...state, recoveries: state.recoveries.filter((recovery) => recovery.recoveryId !== action.recoveryId) };
    case "local-recovery-upserted":
      return {
        ...state,
        localRecoveries: [
          action.recovery,
          ...state.localRecoveries.filter((recovery) => recovery.recoveryId !== action.recovery.recoveryId)
        ]
      };
    case "local-recovery-removed":
      return { ...state, localRecoveries: state.localRecoveries.filter((recovery) => recovery.recoveryId !== action.recoveryId) };
  }
}
