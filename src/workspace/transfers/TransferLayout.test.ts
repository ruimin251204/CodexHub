import { describe, expect, test } from "vitest";
// @ts-expect-error Vitest runtime provides node:fs; production code stays browser-only.
import { readFileSync } from "node:fs";

const testProcess = (globalThis as typeof globalThis & { process: { cwd: () => string } }).process;
const styles = readFileSync(`${testProcess.cwd()}/src/workspace/transfers-redesign.css`, "utf8");

describe("Transfers dashboard layout", () => {
  test("keeps statistics at their content height while the page content scrolls", () => {
    expect(styles).toMatch(/\.transferPageContent\s*\{[^}]*grid-auto-rows:\s*max-content;[^}]*align-content:\s*start;[^}]*overflow-y:\s*auto;/su);
    expect(styles).toMatch(/\.transferStats\s*\{[^}]*min-height:\s*110px;/su);
  });

  test("uses the shared page-action weight and size for header buttons", () => {
    expect(styles).toMatch(/\.transferPageActions button\s*\{[^}]*font-size:\s*0\.875rem;[^}]*font-weight:\s*700;/su);
  });
});
