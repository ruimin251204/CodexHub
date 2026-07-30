import { expect, test } from "vitest";
import appSource from "../App.tsx?raw";
import terminalPanelSource from "./TerminalPanel.tsx?raw";
import workspacePageSource from "./WorkspacePage.tsx?raw";

test("Workspace remains outside the non-Workspace initial module boundary", () => {
  expect(appSource).toMatch(/const WorkspacePage = lazy\(async \(\) => \{/);
  expect(appSource).toContain('import("./workspace/WorkspacePage")');
  expect(appSource).not.toMatch(/^import\s+\{\s*WorkspacePage\s*\}\s+from\s+["']\.\/workspace\/WorkspacePage["'];?$/m);
  expect(appSource).toContain("<Suspense fallback=");
});

test("safe no-replace failures retain a specific bilingual safety explanation", () => {
  const noOverwriteZh = String.fromCodePoint(0x6587, 0x4ef6, 0x672a, 0x88ab, 0x8986, 0x76d6);
  expect(appSource).toContain('normalized.includes("safe-no-replace-unsupported")');
  expect(appSource).toContain("return copy.feedback.safeNoReplaceUnsupported;");
  expect(appSource).toContain("No file was overwritten");
  expect(appSource).toContain(noOverwriteZh);
});

test("terminal renderer failures create a fixed sanitized task summary", () => {
  expect(appSource).toContain('api.recordFrontendError("Workspace terminal renderer initialization failed.")');
  expect(appSource).toContain("terminalRendererTaskKeysRef");
  expect(appSource).toContain("failure.sessionId}:${failure.generation}:${failure.retry");
  expect(appSource).not.toContain("recordFrontendError(formatError(error))");
});

test("Workspace uses the Terminal page title without rendering a duplicate page heading", () => {
  const terminalTitleZh = String.fromCodePoint(0x7ec8, 0x7aef);
  expect(appSource).toContain('title: "Terminal"');
  expect(appSource).toContain(`title: "${terminalTitleZh}"`);
  expect(workspacePageSource).not.toContain('className="workspacePageHeader"');
  expect(workspacePageSource).not.toContain("<h1>{copy.title}</h1>");
  expect(workspacePageSource).not.toContain("<p>{copy.description}</p>");
});

test("terminal chrome avoids duplicate aliases and keeps Split Files-first", () => {
  expect(terminalPanelSource).toContain("host.name === host.hostAlias ? host.hostAlias");
  expect(terminalPanelSource).toContain("session.title !== session.hostAlias");
  expect(terminalPanelSource).not.toContain("workspaceTerminalStatus");
  expect(terminalPanelSource).not.toContain('>UTF-8<');
  expect(terminalPanelSource).not.toContain("onOpenTask");
  expect(workspacePageSource).toContain("useState(40)");
  expect(workspacePageSource).not.toContain("closeTarget");
  expect(workspacePageSource).not.toContain("workspace-close-terminal-title");
  expect(workspacePageSource.indexOf('className="workspaceModeFiles"')).toBeLessThan(
    workspacePageSource.indexOf('className="workspaceModeTerminal"')
  );
});
