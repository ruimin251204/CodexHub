import { describe, expect, test } from "vitest";
// 项目生产代码不依赖 Node；这里只在 Vitest 中读取样式源文件做静态契约检查。
// @ts-expect-error 测试环境未安装 @types/node，但 Vitest 运行时提供该内置模块。
import { readFileSync } from "node:fs";

const testProcess = (globalThis as typeof globalThis & { process: { cwd: () => string } }).process;
const css = readFileSync(`${testProcess.cwd()}/src/components/design-system.css`, "utf8");

describe("platform radius tokens", () => {
  test("defines the approved Windows defaults and 220px sidebar", () => {
    expect(css).toContain("--radius-control-sm: 4px");
    expect(css).toContain("--radius-control: 6px");
    expect(css).toContain("--radius-surface: 8px");
    expect(css).toContain("--radius-dialog: 8px");
    expect(css).toContain("--radius-main-corner: 8px");
    expect(css).toContain("--ch-sidebar-width: 220px");
  });

  test("defines the approved macOS semantic values and compatibility aliases", () => {
    expect(css).toMatch(/:root\[data-platform="macos"\][\s\S]*--radius-control-sm: 6px[\s\S]*--radius-control: 8px[\s\S]*--radius-surface: 12px[\s\S]*--radius-dialog: 14px[\s\S]*--radius-main-corner: 12px/);
    expect(css).toContain("--ch-radius-sm: var(--radius-control-sm)");
    expect(css).toContain("--ch-radius-md: var(--radius-control)");
    expect(css).toContain("--ch-radius-lg: var(--radius-surface)");
  });
});
