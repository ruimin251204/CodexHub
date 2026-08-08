import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { SshHostModal, uiCopy } from "../App";
import type { SshConfigWriteResult } from "../models";

test("editing an SSH Host allows alias rename without requesting the bootstrap password", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn().mockResolvedValue({
    changed: true,
    action: "renamed",
    configPath: "C:\\Users\\Test\\.ssh\\config",
    backupPath: "C:\\Users\\Test\\.ssh\\config.bak.1",
    host: {
      alias: "server-6",
      hostName: "192.0.2.6",
      port: 22,
      user: "codex",
      identityFile: "C:\\Users\\Test\\.ssh\\id_ed25519",
      managed: true,
      source: "managed"
    },
    message: "Host server-6 was renamed."
  } satisfies SshConfigWriteResult);

  render(
    <SshHostModal
      copy={uiCopy.zh}
      defaultIdentityFile="C:\\Users\\Test\\.ssh\\id_ed25519"
      initialDraft={{
        alias: "6",
        hostName: "192.0.2.6",
        port: 22,
        user: "codex",
        identityFile: "C:\\Users\\Test\\.ssh\\id_ed25519"
      }}
      open
      sshBusy={false}
      sshStatus={null}
      onClose={vi.fn()}
      onConnect={vi.fn()}
      onGenerateEd25519Key={vi.fn()}
      onSave={onSave}
    />
  );

  const alias = screen.getByLabelText("Host 别名");
  expect(alias).not.toHaveAttribute("readonly");
  expect(screen.queryByLabelText("一次性密码")).not.toBeInTheDocument();

  await user.clear(alias);
  await user.type(alias, "server-6");
  await user.click(screen.getByRole("button", { name: "保存 SSH 配置" }));

  await waitFor(() => expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ alias: "server-6" }),
    "6"
  ));
});
