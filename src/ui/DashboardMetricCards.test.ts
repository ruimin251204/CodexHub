import { describe, expect, test } from "vitest";
// @ts-expect-error Vitest runtime provides node:fs; production code stays browser-only.
import { readFileSync } from "node:fs";

const testProcess = (globalThis as typeof globalThis & { process: { cwd: () => string } }).process;
const projectRoot = testProcess.cwd();
const appSource = readFileSync(`${projectRoot}/src/App.tsx`, "utf8");
const styles = readFileSync(`${projectRoot}/src/styles.css`, "utf8");

describe("dashboard metric cards", () => {
  test("keeps four real metrics with matching line icons and tones", () => {
    for (const contract of [
      'icon="hosts" label={labelFor("hosts")} tone="blue"',
      'icon="profiles" label={labelFor("profiles")} tone="green"',
      'icon="skills" label={labelFor("skills")} tone="orange"',
      'icon="tasks" label={labelFor("tasks")} tone="blue"'
    ]) {
      expect(appSource).toContain(contract);
    }
    expect(appSource).toContain('<div className="metricIcon" aria-hidden="true">');
    expect(appSource).toContain("<WindowsIcon id={icon} />");
  });

  test("matches the spacious reference layout and remains responsive", () => {
    expect(styles).toMatch(/\.metricCard\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*min-height:\s*148px;/su);
    expect(styles).toMatch(/\.metricPrimary\s*\{[^}]*grid-template-columns:\s*minmax\(0, max-content\) max-content;[^}]*align-items:\s*baseline;/su);
    expect(styles).toMatch(/\.metricPrimary strong\s*\{[^}]*font-size:\s*2rem;/su);
    expect(styles).toMatch(/\.metricSecondary\s*\{[^}]*grid-column:\s*1 \/ -1;/su);
    expect(styles).toMatch(/\.metricIcon\s*\{[^}]*width:\s*72px;[^}]*height:\s*72px;/su);
    expect(styles).toMatch(/@media \(max-width:\s*1120px\)[\s\S]*?\.summaryStrip\s*\{\s*grid-template-columns:\s*repeat\(2,/u);
  });
});
