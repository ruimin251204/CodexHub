import { describe, expect, test } from "vitest";
// 项目生产代码不依赖 Node；这里只在 Vitest 中读取样式源文件做静态契约检查。
// @ts-expect-error 测试环境未安装 @types/node，但 Vitest 运行时提供该内置模块。
import { readFileSync, readdirSync } from "node:fs";

const testProcess = (globalThis as typeof globalThis & { process: { cwd: () => string } }).process;
const css = readFileSync(`${testProcess.cwd()}/src/components/design-system.css`, "utf8");
const appCss = readFileSync(`${testProcess.cwd()}/src/styles.css`, "utf8");

const approvedRadiusTokens = new Set([
  "--radius-control-sm",
  "--radius-control",
  "--radius-surface",
  "--radius-dialog",
  "--radius-main-corner",
  "--radius-pill"
]);

// 仅这些几何装饰需要固定小圆角；新增例外必须在此明确说明 selector。
const decorativeRadiusAllowlist = new Set([
  "styles.css|.navItem::before|2px",
  "styles.css|.terminalCursorChoiceSample::before|1px",
  "components/design-system.css|.ch-tabs[data-variant=\"underline\"] .ch-tabs__tab[aria-selected=\"true\"]::after|2px 2px 0 0"
]);

function listProductionCss(relativeDirectory = ""): string[] {
  const directory = `${testProcess.cwd()}/src${relativeDirectory ? `/${relativeDirectory}` : ""}`;
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry: {
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
  }) => {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listProductionCss(relativePath);
    return entry.isFile() && entry.name.endsWith(".css") ? [relativePath] : [];
  });
}

function selectorBefore(cssSource: string, declarationIndex: number): string {
  const blockStart = cssSource.lastIndexOf("{", declarationIndex);
  const previousBlockEnd = cssSource.lastIndexOf("}", blockStart);
  return cssSource
    .slice(previousBlockEnd + 1, blockStart)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isSemanticRadius(value: string): boolean {
  const parts = value.match(/var\(--[^)]+\)|inherit|0/gu) ?? [];
  if (parts.join(" ") !== value.replace(/\s+/gu, " ").trim()) return false;
  return parts.every((part) => part === "0" || part === "inherit" || approvedRadiusTokens.has(part.slice(4, -1)));
}

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

  test("tasks and settings use semantic platform radius tokens", () => {
    for (const selector of [
      ".taskTimeline",
      ".taskTimelineLogButton",
      ".settingsChoiceCard",
      ".settingsToggleList",
      ".terminalColorChoice",
      ".terminalBehaviorList",
      ".hostsGrid .detailGrid > div"
    ]) {
      const rule = appCss.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{[^}]*\\}`, "u"))?.[0] ?? "";
      expect(rule, selector).toMatch(/border-radius:\s*var\(--radius-(?:control|surface)\)/u);
    }
  });

  test("all production CSS routes visible radii through semantic platform tokens", () => {
    const violations: string[] = [];
    const usedDecorativeExceptions = new Set<string>();

    for (const relativePath of listProductionCss()) {
      const source = readFileSync(`${testProcess.cwd()}/src/${relativePath}`, "utf8");
      for (const match of source.matchAll(/border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;]+);/gu)) {
        const value = match[1].replace(/\s+/gu, " ").trim();
        if (isSemanticRadius(value)) continue;

        const selector = selectorBefore(source, match.index ?? 0);
        const exception = `${relativePath}|${selector}|${value}`;
        if (decorativeRadiusAllowlist.has(exception)) {
          usedDecorativeExceptions.add(exception);
          continue;
        }
        violations.push(exception);
      }
    }

    expect(violations).toEqual([]);
    expect(usedDecorativeExceptions).toEqual(decorativeRadiusAllowlist);
  });
});
