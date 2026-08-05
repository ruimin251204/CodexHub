import { describe, expect, test } from "vitest";
// @ts-expect-error Vitest runtime provides node:fs; production code stays browser-only.
import { readFileSync } from "node:fs";

const testProcess = (globalThis as typeof globalThis & { process: { cwd: () => string } }).process;
const projectRoot = testProcess.cwd();
const appSource = readFileSync(`${projectRoot}/src/App.tsx`, "utf8");
const styles = readFileSync(`${projectRoot}/src/styles.css`, "utf8");

describe("list toolbar actions", () => {
  test("keeps profile import and cc-switch actions at one height", () => {
    expect(appSource).toContain('className="secondaryButton pageActionButton listToolbarAction" data-action-tone="import" type="button" onClick={() => importInputRef.current?.click()}');
    expect(appSource).toContain('pageActionButton listToolbarAction ccSwitchActionButton`');
    expect(styles).toMatch(/\.listToolbarAction\s*\{[^}]*height:\s*38px;[^}]*min-height:\s*38px;[^}]*padding-block:\s*0;/su);
    expect(styles).toMatch(/\.ccSwitchActionButton\s*\{[^}]*width:\s*168px;[^}]*white-space:\s*nowrap;/su);
  });

  test("maps repeated action semantics to shared colors", () => {
    for (const [tone, color] of [
      ["detect", "var(--action-detect)"],
      ["test", "var(--action-test)"],
      ["update", "var(--action-update)"],
      ["import", "var(--action-import)"],
      ["refresh", "var(--blue)"],
      ["download", "var(--green)"]
    ]) {
      expect(styles).toContain(`.pageActionButton[data-action-tone="${tone}"] { --list-action-color: ${color}; }`);
    }
    expect(appSource.match(/data-action-tone="detect"/gu) ?? []).toHaveLength(2);
    expect(appSource.match(/data-action-tone="import"/gu) ?? []).toHaveLength(2);
    expect(appSource).toContain('data-action-tone={canImportCcSwitchDetection ? "import" : "detect"}');
  });

  test("colors both secondary and primary toolbar actions without changing behavior", () => {
    expect(styles).toContain(".secondaryButton.pageActionButton[data-action-tone]");
    expect(styles).toContain(".primaryButton.pageActionButton[data-action-tone]");
    for (const action of ["onTestAllSshHosts", "onUpdateOutdatedCodexHosts", "handleDetectCcSwitch", "handleDetectClick", "handleRefresh", "handleImport", "openDownload"]) {
      expect(appSource).toContain(action);
    }
  });
});
