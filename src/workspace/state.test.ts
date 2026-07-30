import { expect, test } from "vitest";
import { initialWorkspaceState, workspaceStateReducer } from "./state";
import type { WorkspaceTerminalSession, WorkspaceTransfer } from "./types";

const session = (generation: number, revision: number): WorkspaceTerminalSession => ({
  sessionId: "term-test",
  hostAlias: "test-host",
  title: "test-host",
  generation,
  revision,
  state: "connected",
  reconnectable: true,
  autoReconnect: true,
  attempt: 0,
  nextRetryAt: null,
  reason: null,
  createdAt: "2026-07-30T00:00:00Z"
});

const transfer = (revision: number): WorkspaceTransfer => ({
  transferId: "transfer-test",
  revision,
  direction: "upload",
  hostAlias: "test-host",
  sourceLabel: "source.txt",
  targetLabel: "/home/test/source.txt",
  state: "running",
  bytes: "1",
  total: "2",
  speedBytesPerSecond: "1",
  etaSeconds: 1,
  attempt: 1,
  resumable: true,
  resumeOffset: "1",
  fingerprintState: "verified",
  errorCode: null,
  errorMessage: null,
  taskId: "task-test",
  conflictRevision: null,
  capabilities: { canPause: true, canResume: false, canCancel: true, canRetry: false, canRestart: false }
});

test("Workspace state rejects delayed session generations and revisions", () => {
  let state = workspaceStateReducer(initialWorkspaceState, { type: "session-upserted", session: session(2, 4) });
  state = workspaceStateReducer(state, {
    type: "session-state-received",
    event: {
      sessionId: "term-test", generation: 1, revision: 99, state: "failed",
      reconnectable: false, attempt: 5, nextRetryAt: null, reason: "stale"
    }
  });
  state = workspaceStateReducer(state, {
    type: "session-state-received",
    event: {
      sessionId: "term-test", generation: 2, revision: 5, state: "reconnecting",
      reconnectable: true, attempt: 1, nextRetryAt: "2026-07-30T00:00:01Z", reason: null
    }
  });

  expect(state.sessions[0]).toMatchObject({ generation: 2, revision: 5, state: "reconnecting", attempt: 1 });
});

test("Workspace transfer snapshot cannot overwrite a newer event", () => {
  let state = workspaceStateReducer(initialWorkspaceState, { type: "transfer-received", event: transfer(5) });
  state = workspaceStateReducer(state, {
    type: "transfers-loaded",
    snapshot: { transfers: [transfer(3)], recoveries: [], localRecoveries: [] }
  });

  expect(state.transfers).toHaveLength(1);
  expect(state.transfers[0]?.revision).toBe(5);
});

test("Workspace transfer events merge progress without reloading the queue", () => {
  let state = workspaceStateReducer(initialWorkspaceState, {
    type: "transfers-loaded",
    snapshot: { transfers: [transfer(1)], recoveries: [], localRecoveries: [] }
  });
  state = workspaceStateReducer(state, {
    type: "transfer-received",
    event: {
      transferId: "transfer-test",
      revision: 2,
      state: "interrupted",
      bytes: "9",
      total: "12",
      speedBytesPerSecond: null,
      etaSeconds: null,
      attempt: 2,
      resumable: true,
      errorCode: "interrupted",
      taskId: "task-test"
    }
  });

  expect(state.transfers[0]).toMatchObject({
    revision: 2,
    state: "interrupted",
    bytes: "9",
    sourceLabel: "source.txt",
    capabilities: { canResume: true, canRetry: true }
  });
});
