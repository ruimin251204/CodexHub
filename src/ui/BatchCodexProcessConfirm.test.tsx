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
                  { pid: 41, startTime: "100", processName: "codex", version: "0.145.0", releasePath: "/home/a/releases/0.145.0" },
                  { pid: 42, startTime: "101", processName: "codex-code-mode", version: "0.145.0", releasePath: "/home/a/releases/0.145.0" }
                ]
              },
              {
                hostAlias: "busy-b",
                ok: true,
                message: "One process",
                processes: [
                  { pid: 51, startTime: "200", processName: "codex", version: "0.145.0", releasePath: "/home/b/releases/0.145.0" }
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
    expect(screen.getByText("PID 42 · codex-code-mode · 0.145.0")).toBeVisible();
    expect(screen.getByText("Continues automatically")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Select all affected hosts" }));
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();
    expect(checkboxes[2]).toBeDisabled();
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "Continue with selection" }));
    expect(onConfirm).toHaveBeenCalledWith(["busy-a"]);
  });
});
