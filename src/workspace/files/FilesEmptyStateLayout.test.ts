import { describe, expect, test } from "vitest";
// @ts-expect-error Vitest runtime provides node:fs; production code stays browser-only.
import { readFileSync } from "node:fs";

const testProcess = (globalThis as typeof globalThis & { process: { cwd: () => string } }).process;
const styles = readFileSync(`${testProcess.cwd()}/src/workspace/files-redesign.css`, "utf8");

describe("Files empty-state placement", () => {
  test("centers empty content above the vertical midpoint of the table pane", () => {
    expect(styles).toMatch(/\.workspaceFilesTablePane\s*\{[^}]*position:\s*relative;/su);
    expect(styles).toMatch(/\.workspaceFilesRedesign \.workspaceFileEmpty\s*\{[^}]*position:\s*absolute;[^}]*top:\s*42%;[^}]*left:\s*50%;[^}]*transform:\s*translate\(-50%, -50%\);/su);
  });
});
