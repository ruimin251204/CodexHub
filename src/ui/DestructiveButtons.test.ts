import { describe, expect, test } from "vitest";
import appSource from "../App.tsx?raw";
import filesPanelSource from "../workspace/FilesPanel.tsx?raw";
import fileDetailsSource from "../workspace/files/FileDetailsPanel.tsx?raw";
import fileDialogsSource from "../workspace/files/FileDialogs.tsx?raw";
// @ts-expect-error Vitest runtime provides node:fs; production code stays browser-only.
import { readFileSync } from "node:fs";

const testProcess = (globalThis as typeof globalThis & { process: { cwd: () => string } }).process;
const projectRoot = testProcess.cwd();
const styles = readFileSync(`${projectRoot}/src/styles.css`, "utf8");
const designSystemStyles = readFileSync(`${projectRoot}/src/components/design-system.css`, "utf8");
const filesStyles = readFileSync(`${projectRoot}/src/workspace/files-redesign.css`, "utf8");
const transferStyles = readFileSync(`${projectRoot}/src/workspace/transfers-redesign.css`, "utf8");

describe("destructive action buttons", () => {
  test("uses one red primary-action palette with hover, focus and shadow states", () => {
    for (const token of [
      "--danger-action-accent",
      "--danger-action-background: linear-gradient",
      "--danger-action-hover-background: linear-gradient",
      "--danger-action-shadow",
      "--danger-action-text: #ffffff"
    ]) {
      expect(styles).toContain(token);
    }
    expect(styles).toMatch(/\.miniButton\.danger,\s*\.dangerButton\s*\{[^}]*background:\s*var\(--danger-action-background\);[^}]*box-shadow:\s*var\(--danger-action-shadow\);/su);
    expect(styles).toContain(".dangerButton:hover:not(:disabled)");
    expect(styles).toContain(".dangerButton:focus-visible");
    expect(styles).toContain(".workspaceDangerButton:hover:not(:disabled)");
    expect(designSystemStyles).toContain('.ch-action-button[data-variant="danger"] { border-color: transparent; color: var(--danger-action-text); background: var(--danger-action-background); box-shadow: var(--danger-action-shadow); }');
  });

  test("marks host, profile, skill and history destructive actions consistently", () => {
    expect(appSource).toContain('className="miniButton danger" disabled={uninstallDisabled}');
    expect(appSource).toContain('className="miniButton danger" disabled={busy === "delete"}');
    expect(appSource).toContain('className="miniButton danger" disabled={Boolean(busy) || skill.applications.length === 0}');
    expect(appSource).toContain('className={mode === "uninstall" ? "primaryButton dangerButton" : "primaryButton"}');
    expect(appSource).toContain('<button className="primaryButton dangerButton" disabled={busy} type="button" onClick={() => onDelete(true)}>');
    expect(appSource).toContain('className="secondaryButton dangerButton pageActionButton"');
  });

  test("marks file deletion and recovery purge actions without coloring ordinary confirms", () => {
    expect(filesPanelSource).toContain('className="workspaceFilesDeleteButton"');
    expect(filesPanelSource).toContain('className="workspaceDangerButton" role="menuitem"');
    expect(fileDetailsSource).toContain('className="workspaceDangerButton" disabled={!canMutate}');
    expect(fileDialogsSource.match(/className="workspaceDangerButton"/gu) ?? []).toHaveLength(2);
    expect(fileDialogsSource).toContain('{preview ? <button className="workspacePrimaryButton"');
    expect(filesStyles).toContain("background: var(--danger-action-background);");
    expect(transferStyles).toContain(".transferRecoveryActions .transferDangerAction");
    expect(transferStyles).toContain("background: var(--danger-action-background);");
  });
});
