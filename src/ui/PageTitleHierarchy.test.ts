import { describe, expect, test } from "vitest";
// @ts-expect-error Vitest runtime provides node:fs; production code stays browser-only.
import { readFileSync } from "node:fs";

const testProcess = (globalThis as typeof globalThis & { process: { cwd: () => string } }).process;
const projectRoot = testProcess.cwd();
const appStyles = readFileSync(`${projectRoot}/src/styles.css`, "utf8");
const shellStyles = readFileSync(`${projectRoot}/src/components/app-shell-integration.css`, "utf8");

describe("page title hierarchy", () => {
  test("keeps management and Monitor page titles consistent", () => {
    expect(appStyles).toContain("--page-title-size: 1.8rem");
    expect(appStyles).toMatch(/\.topBar h1\s*\{[^}]*font-size:\s*var\(--page-title-size\);[^}]*line-height:\s*1\.2;/su);
    expect(appStyles).toMatch(/\.monitorHeroHeader \.titleWithIcon\s*\{[^}]*font-size:\s*var\(--page-title-size\);[^}]*line-height:\s*1\.2;/su);
  });

  test("makes Terminal, Files, and Transfers inherit the same title size", () => {
    expect(appStyles).toContain("--workspace-title-size: var(--page-title-size)");
    for (const section of ["terminal", "files", "transfers"]) {
      expect(shellStyles).toContain(`.codexHubContent[data-section="${section}"] > .topBar h1`);
    }
    expect(shellStyles).toContain("font-size: var(--workspace-title-size); line-height: 1.2;");
  });
});
