import { expect, test } from "vitest";
import appSource from "../App.tsx?raw";
import filesPanelSource from "./FilesPanel.tsx?raw";
import terminalPanelSource from "./TerminalPanel.tsx?raw";
import terminalStatusBarSource from "./terminal/TerminalStatusBar.tsx?raw";
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

test("Workspace uses sidebar navigation and removes the unused four-button title-bar mode switcher", () => {
  expect(appSource).not.toContain('className="topActions workspaceTopActions"');
  expect(appSource).not.toContain("modeBarHost={workspaceModeBarHost}");
  expect(workspacePageSource).not.toContain('import { createPortal } from "react-dom"');
  expect(workspacePageSource).not.toContain('className="workspaceModeBar"');
  expect(appSource).toContain('const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("terminal")');
  expect(appSource).toContain("onModeChange={selectWorkspaceMode}");
});

test("Workspace does not auto-select a host and keeps Hosts first in Management", () => {
  expect(appSource).toContain('if (!current) return "";');
  expect(appSource).toContain('return hosts.some((host) => host.hostAlias === current) ? current : "";');
  expect(appSource).toContain('items: (["dashboard", "terminal", "files", "transfers"] as SectionId[]).map(makeSidebarItem)');
  expect(appSource).toContain('items: (["hosts", "monitor", "profiles", "skills", "tasks"] as SectionId[]).map(makeSidebarItem)');
});

test("terminal chrome uses a single tab alias, exposes factual status, and keeps Split Files-first", () => {
  expect(terminalPanelSource).toContain("workspaceHostLabel(host)");
  expect(terminalPanelSource).toContain("session.hostAlias || session.title");
  expect(terminalPanelSource).toContain("<TerminalStatusBar");
  expect(terminalStatusBarSource).toContain("session.createdAt");
  expect(terminalStatusBarSource).toContain("copy.renderer");
  expect(terminalStatusBarSource).not.toContain("xterm-256color");
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

test("Files keeps primary navigation in one command bar and moves secondary actions into a menu", () => {
  const commandBarIndex = filesPanelSource.indexOf('className="workspacePaneToolbar workspaceFilesCommandBar"');
  expect(commandBarIndex).toBeGreaterThan(-1);
  expect(commandBarIndex).toBeLessThan(filesPanelSource.indexOf('className="workspaceSearchForm"'));
  expect(filesPanelSource).toContain('className="workspaceFilesMoreActions"');
  expect(filesPanelSource).toContain('className="workspaceFilesMoreMenu"');
});
