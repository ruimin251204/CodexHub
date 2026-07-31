import { expect, test } from "vitest";
import appSource from "../App.tsx?raw";
import filesPanelSource from "./FilesPanel.tsx?raw";
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

test("Workspace mode tabs mount in the global title bar so the main panel keeps the standard top spacing", () => {
  expect(appSource).toContain('className="topActions workspaceTopActions"');
  expect(appSource).toContain("modeBarHost={workspaceModeBarHost}");
  expect(workspacePageSource).toContain('import { createPortal } from "react-dom"');
  expect(workspacePageSource).toContain("createPortal(modeBar, modeBarHost)");
});

test("terminal chrome avoids duplicate aliases and keeps Split Files-first", () => {
  expect(terminalPanelSource).toContain("workspaceHostLabel(host)");
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

test("Files starts locally, shares host labels, and keeps Split linked without leaving it", () => {
  expect(workspacePageSource).not.toContain("setSelectedHostAlias(hosts[0].hostAlias)");
  expect(workspacePageSource).toContain('const keepSplit = mode === "split"');
  expect(workspacePageSource).toContain('chooseMode(keepSplit ? "split" : "terminal")');
  expect(workspacePageSource).toContain('if (mode !== "split" || !activeTerminal) return;');
  expect(filesPanelSource).toContain("workspaceHostLabel(host)");
  expect(terminalPanelSource).toContain("workspaceHostLabel(host)");
});

test("Files toolbar places search with the host and wraps secondary actions below narrow paths", () => {
  expect(filesPanelSource.indexOf('className="workspaceSearchForm"')).toBeLessThan(
    filesPanelSource.indexOf('className="workspacePaneToolbar workspaceFilesNavigation"')
  );
  expect(filesPanelSource).toContain('className="workspaceFilesSecondaryActions"');
});
