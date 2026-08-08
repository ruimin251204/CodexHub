import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { BatchCodexProcessConfirmModal, uiCopy } from "../App";
import type { Host } from "../models";

function host(hostAlias: string, name: string): Host {
  return {
    id: `host-${hostAlias}`,
    name,
    hostAlias,
    source: "managed",
    address: "127.0.0.1",
    port: 22,
    username: "codex",
    authMethod: "ssh-key",
    status: "online",
    os: "Linux",
    arch: "x86_64",
    shell: "bash",
    path: null,
    pathHasLocalBin: true,
    codexCommandAvailable: true,
    codexInstalled: true,
    codexVersion: "0.145.0",
    configExists: true,
    apiConfigName: null,
    apiConfigSource: null,
    apiKeyEnvVar: null,
    apiKeyEnvPresent: null,
    skillsExists: null,
    skillsCount: null,
    profileId: null,
    skillPackIds: [],
    tags: [],
    lastSeen: "just now",
    latencyMs: 10
  };
}

describe("BatchCodexProcessConfirmModal", () => {
  test("shows all hosts once and submits one partial host selection", () => {
    const onConfirm = vi.fn();
    render(
      <BatchCodexProcessConfirmModal
        copy={uiCopy.en}
        hosts={[host("busy-a", "Alpha"), host("busy-b", "Beta"), host("clear-c", "Clear")]}
        request={{
          requestId: "batch-process-1",
          preview: {
            requestId: "batch-process-1",
            results: [
              {
                hostAlias: "busy-a",
                ok: true,
                message: "Two processes",
                processes: [
                  { pid: 41, startTime: "100", processName: "codex", processKind: "app-server", version: "0.145.0", releasePath: "/home/a/releases/0.145.0" },
                  { pid: 42, startTime: "101", processName: "codex-code-mode", processKind: "app-server-proxy", version: "0.145.0", releasePath: "/home/a/releases/0.145.0" }
                ]
              },
              {
                hostAlias: "busy-b",
                ok: true,
                message: "One process",
                processes: [
                  { pid: 51, startTime: "200", processName: "codex", processKind: "codex-session", version: "0.145.0", releasePath: "/home/b/releases/0.145.0" }
                ]
              },
              { hostAlias: "clear-c", ok: true, message: "Clear", processes: [] }
            ]
          }
        }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByText("PID 42 · Codex App SSH proxy · 0.145.0")).toBeVisible();
    expect(screen.getByText(/exact-PID SIGKILL/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Force stop and update selected" })).toBeVisible();
    expect(screen.getAllByText(/temporarily disconnects this host/)).not.toHaveLength(0);
    expect(screen.getByText("Continues automatically")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Select all affected hosts" }));
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();
    expect(checkboxes[2]).toBeDisabled();
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "Force stop and update selected" }));
    expect(onConfirm).toHaveBeenCalledWith(["busy-a"]);
  });

  test("blocks a single host when any process classification is unknown", () => {
    const onConfirm = vi.fn();
    render(
      <BatchCodexProcessConfirmModal
        copy={uiCopy.en}
        hosts={[host("unknown-a", "Unknown host")]}
        request={{
          requestId: "single-process-1",
          preview: {
            requestId: "single-process-1",
            results: [{
              hostAlias: "unknown-a",
              ok: true,
              message: "One unclassified process",
              processes: [{
                pid: 61,
                startTime: "300",
                processName: "codex",
                processKind: "unknown",
                version: "0.145.0",
                releasePath: "/home/a/releases/0.145.0"
              }]
            }]
          }
        }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByText("PID 61 · Unclassified Codex process · 0.145.0")).toBeVisible();
    expect(screen.getByText(/could not be safely classified/)).toBeVisible();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Select all affected hosts" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Force stop and update selected" }));
    expect(onConfirm).toHaveBeenCalledWith([]);
  });
});
