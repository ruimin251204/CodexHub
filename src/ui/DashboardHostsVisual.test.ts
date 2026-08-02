import { describe, expect, test } from "vitest";
import app from "../App.tsx?raw";

describe("Dashboard and Hosts visual contracts", () => {
  test("Dashboard uses shared metrics and retains complete host metadata", () => {
    expect(app.match(/<SharedMetricCard/g)).toHaveLength(4);
    for (const token of [
      "dashboardMetrics",
      "copy.hosts.source",
      "copy.dashboard.system",
      "copy.hosts.arch",
      "copy.hosts.codex",
      "copy.hosts.configExists",
      "copy.hosts.latency",
      "copy.hosts.skills"
    ]) {
      expect(app).toContain(token);
    }
  });

  test("Hosts uses the shared table without hiding fields or removing actions", () => {
    for (const token of [
      'className="hostsDataTable"',
      'id: "alias"',
      'id: "status"',
      'id: "source"',
      'id: "address"',
      'id: "port"',
      'id: "user"',
      'id: "codex-version"',
      'onTestHost(sshHost.alias)',
      'handleEdit(sshHost)',
      'onManageCodex(sshHost.alias, "install")',
      'onManageCodex(sshHost.alias, "update")',
      'onManageCodex(sshHost.alias, "uninstall")',
      'setDeleteHostAlias(sshHost.alias)'
    ]) {
      expect(app).toContain(token);
    }
  });
});
