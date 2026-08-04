import { describe, expect, test } from "vitest";
// @ts-expect-error Vitest runtime provides node:fs; production code stays browser-only.
import { readFileSync } from "node:fs";

const testProcess = (globalThis as typeof globalThis & { process: { cwd: () => string } }).process;
const projectRoot = testProcess.cwd();
const appSource = readFileSync(`${projectRoot}/src/App.tsx`, "utf8");
const styles = readFileSync(`${projectRoot}/src/styles.css`, "utf8");
const actionIconSource = readFileSync(`${projectRoot}/src/components/UI/ActionIcon.tsx`, "utf8");

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

  test("places the color icon first in a spacious responsive layout", () => {
    expect(appSource.indexOf('<div className="metricIcon" aria-hidden="true">')).toBeLessThan(appSource.indexOf('<div className="metricPrimary">'));
    expect(styles).toMatch(/\.metricCard\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\);[^}]*min-height:\s*120px;[^}]*padding:\s*18px 22px;/su);
    expect(styles).toMatch(/\.metricPrimary\s*\{[^}]*grid-template-columns:\s*minmax\(0, max-content\) max-content;[^}]*align-items:\s*baseline;/su);
    expect(styles).toMatch(/\.metricPrimary strong\s*\{[^}]*font-size:\s*2rem;/su);
    expect(styles).toMatch(/\.metricSecondary\s*\{[^}]*grid-column:\s*1 \/ -1;/su);
    expect(styles).toMatch(/\.metricIcon\s*\{[^}]*width:\s*68px;[^}]*height:\s*68px;/su);
    expect(styles).toMatch(/@media \(max-width:\s*1120px\)[\s\S]*?\.summaryStrip\s*\{\s*grid-template-columns:\s*repeat\(2,/u);
  });

  test("groups real host health summaries above compact host cards", () => {
    const matrixSource = appSource.slice(appSource.indexOf("function ServerMatrix("), appSource.indexOf("function HostsView("));
    for (const token of ["matrixOnline", "matrixAbnormal", "matrixAverageLatency", "matrixSkills"]) {
      expect(appSource).toContain(token);
    }
    expect(appSource).toContain('className="panel spanWide dashboardMatrixPanel"');
    expect(appSource).toContain('className="hostMeta hostMetaPrimary"');
    expect(appSource).toContain('className="hostCardFooter"');
    expect(appSource).toContain('className="secondaryButton hostConnectButton"');
    expect(appSource).toContain('onClick={() => onConnectHost(host.hostAlias)}');
    expect(matrixSource).not.toContain("copy.hosts.source");
    expect(matrixSource.indexOf("copy.dashboard.system")).toBeLessThan(matrixSource.indexOf("copy.hosts.codex"));
    expect(matrixSource.indexOf("copy.hosts.codex")).toBeLessThan(matrixSource.indexOf("copy.dashboard.api"));
    expect(styles).toContain(".matrixSummary");
    expect(styles).toContain(".hostCardFooter");
    expect(styles).toMatch(/\.hostMetaPrimary\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.45fr\) minmax\(68px, 0\.7fr\) minmax\(0, 1fr\);/su);
    expect(styles).toMatch(/\.hostCard\s*\{[^}]*grid-template-rows:\s*auto auto auto;[^}]*gap:\s*12px;[^}]*min-height:\s*218px;/su);
  });

  test("uses a dedicated pulse icon for page-level host test actions", () => {
    const rowTestButton = appSource.slice(appSource.indexOf('onTestHost(sshHost.alias)'), appSource.indexOf('onTestHost(sshHost.alias)') + 240);
    expect(appSource.match(/<ActionIcon name="test" \/>/gu) ?? []).toHaveLength(2);
    expect(appSource).toMatch(/onTestAllSshHosts\(\)[^>]*>[\s\S]*?<ActionIcon name="test" \/>/u);
    expect(rowTestButton).toContain("copy.hosts.testing");
    expect(rowTestButton).not.toContain("ActionIcon");
    expect(actionIconSource).toContain('| "test"');
    expect(actionIconSource).toContain('name === "test" ? <path d="M3 12h3.5l2-5 3.25 10 2.5-7 1.75 2h5" />');
  });
});
