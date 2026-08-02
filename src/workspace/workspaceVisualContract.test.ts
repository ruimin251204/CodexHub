import { describe, expect, test } from "vitest";
// 生产代码保持浏览器依赖；这里只在 Vitest 中读取 CSS，锁定跨平台视觉契约。
// @ts-expect-error 测试环境未安装 @types/node，但 Vitest 运行时提供该内置模块。
import { readFileSync } from "node:fs";

const testProcess = (globalThis as typeof globalThis & { process: { cwd: () => string } }).process;
const readCss = (name: string) => readFileSync(`${testProcess.cwd()}/src/workspace/${name}`, "utf8");
const terminalCss = readCss("terminal-redesign.css");
const filesCss = readCss("files-redesign.css");
const transfersCss = readCss("transfers-redesign.css");
const appCss = readFileSync(`${testProcess.cwd()}/src/styles.css`, "utf8");
const workspaceCss = appCss.slice(appCss.indexOf(".workspacePage {"));

describe("Workspace visual contract", () => {
  test("uses semantic radius tokens throughout Workspace chrome", () => {
    for (const css of [terminalCss, filesCss, transfersCss, workspaceCss]) {
      expect(css).not.toMatch(/border-radius:\s*(?:[1-9]\d*px|999px|50%)/);
      expect(css).not.toMatch(/border-radius:\s*var\(--radius-(?:sm|md|lg)\)/);
    }

    expect(terminalCss).toContain("border-radius: var(--radius-surface)");
    expect(filesCss).toContain("border-radius: var(--radius-dialog)");
    expect(transfersCss).toContain("border-radius: var(--radius-pill)");
  });

  test("shares panel, command bar and status bar surfaces", () => {
    expect(workspaceCss).toContain("--workspace-panel-bg:");
    expect(workspaceCss).toContain("--workspace-commandbar-bg:");
    expect(workspaceCss).toContain("--workspace-statusbar-bg:");
    expect(terminalCss).toContain("var(--workspace-commandbar-bg");
    expect(filesCss).toContain("var(--workspace-statusbar-bg");
    expect(transfersCss).toContain("var(--workspace-statusbar-bg");
  });

  test("responds to pane containers at full, 820px and 560px layouts", () => {
    expect(terminalCss).toContain("container: ch-terminal / inline-size");
    expect(filesCss).toContain("@container workspace-files (max-width: 820px)");
    expect(filesCss).toContain("@container workspace-files (max-width: 560px)");
    expect(transfersCss).toContain("container: workspace-transfers / inline-size");
    expect(transfersCss).toContain("@container workspace-transfers (max-width: 820px)");
    expect(transfersCss).toContain("@container workspace-transfers (max-width: 560px)");
  });

  test("keeps Transfers vertical scrolling on its content region", () => {
    expect(transfersCss).toMatch(/\.transferPageContent\s*\{[\s\S]*?overflow-y:\s*auto;/);
    expect(transfersCss).toContain(".transferSupportList { overflow: visible; }");
  });
});
