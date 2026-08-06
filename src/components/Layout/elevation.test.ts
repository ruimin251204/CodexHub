import { describe, expect, test } from "vitest";
// @ts-expect-error Vitest runtime provides node:fs; production code stays browser-only.
import { readFileSync } from "node:fs";

const testProcess = (globalThis as typeof globalThis & { process: { cwd: () => string } }).process;
const projectRoot = testProcess.cwd();
const designSystemStyles = readFileSync(`${projectRoot}/src/components/design-system.css`, "utf8");
const shellStyles = readFileSync(`${projectRoot}/src/components/app-shell-integration.css`, "utf8");

describe("main detail surface elevation", () => {
  test("separates the detail surface with adaptive borders and restrained directional shadows", () => {
    expect(designSystemStyles.match(/--ch-main-surface-border:/g)).toHaveLength(3);
    expect(designSystemStyles.match(/--ch-main-surface-side-shadow:/g)).toHaveLength(3);
    expect(designSystemStyles.match(/--ch-main-surface-top-shadow:/g)).toHaveLength(3);
    expect(shellStyles).toMatch(/\.codexHubMain\s*\{[^}]*border-top:\s*1px solid var\(--ch-main-surface-border\);[^}]*border-left:\s*1px solid var\(--ch-main-surface-border\);[^}]*box-shadow:\s*var\(--ch-main-surface-side-shadow\);/su);
    expect(shellStyles).toMatch(/\.desktopFrame\[data-custom-titlebar="true"\] \.appTitleBar::after\s*\{[^}]*display:\s*block;[^}]*box-shadow:\s*var\(--ch-main-surface-top-shadow\);/su);
  });
});
