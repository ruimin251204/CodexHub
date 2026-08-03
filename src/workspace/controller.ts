import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  initialWorkspaceState,
  workspaceStateReducer,
  type WorkspaceState
} from "./state";
import type { WorkspaceApi } from "./types";
import type {
  WorkspaceLocalTransferRecovery,
  WorkspaceRecovery,
  WorkspaceTerminalSession,
  WorkspaceTransfer
} from "./types";

export type WorkspaceController = {
  state: WorkspaceState;
  reload: () => Promise<void>;
  upsertTransfers: (transfers: WorkspaceTransfer[]) => void;
  upsertSession: (session: WorkspaceTerminalSession) => void;
  removeSession: (sessionId: string) => void;
  upsertRecovery: (recovery: WorkspaceRecovery) => void;
  removeRecovery: (recoveryId: string) => void;
  upsertLocalRecovery: (recovery: WorkspaceLocalTransferRecovery) => void;
  removeLocalRecovery: (recoveryId: string) => void;
};

/**
 * Keeps durable session/transfer state in one place.  Terminal byte frames are
 * intentionally handled by XtermTerminal refs and never enter this reducer.
 */
export function useWorkspaceController(
  api: WorkspaceApi,
  onError: (error: unknown) => void
): WorkspaceController {
  const [state, dispatch] = useReducer(workspaceStateReducer, initialWorkspaceState);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const reload = useCallback(async () => {
    const [sessions, transfers] = await Promise.all([
      api.listTerminalSessions(),
      api.listTransfers()
    ]);
    dispatch({ type: "sessions-loaded", sessions });
    dispatch({ type: "transfers-loaded", snapshot: transfers });
  }, [api]);

  useEffect(() => {
    let disposed = false;
    const stops: Array<() => void> = [];

    const subscribe = (registration: Promise<() => void> | (() => void)) => {
      void Promise.resolve(registration).then((stop) => {
        if (disposed) stop();
        else stops.push(stop);
      }).catch((error) => onErrorRef.current(error));
    };

    subscribe(api.events.onSessionState((event) => {
      dispatch({ type: "session-state-received", event });
    }));
    subscribe(api.events.onSessionHeartbeat((event) => {
      dispatch({ type: "session-heartbeat-received", event });
    }));
    subscribe(api.events.onTerminalCwd((event) => {
      dispatch({ type: "session-cwd-received", event });
    }));
    subscribe(api.events.onTransferUpdated((event) => {
      dispatch({ type: "transfer-received", event });
    }));

    void reload().catch((error) => onErrorRef.current(error));
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
    // Api lifetime is owned by the desktop boundary.  Re-subscribe only if it
    // changes, never for state updates.
  }, [api, reload]);

  return {
    state,
    reload,
    upsertTransfers: (transfers) => dispatch({ type: "transfers-upserted", transfers }),
    upsertSession: (session) => dispatch({ type: "session-upserted", session }),
    removeSession: (sessionId) => dispatch({ type: "session-removed", sessionId }),
    upsertRecovery: (recovery) => dispatch({ type: "recovery-upserted", recovery }),
    removeRecovery: (recoveryId) => dispatch({ type: "recovery-removed", recoveryId }),
    upsertLocalRecovery: (recovery) => dispatch({ type: "local-recovery-upserted", recovery }),
    removeLocalRecovery: (recoveryId) => dispatch({ type: "local-recovery-removed", recoveryId })
  };
}
