import { expect, test } from "vitest";
import { defaultSettings, normalizeSettings, workspaceTerminalPreferences } from "./settings";

test("Workspace terminal preferences are persisted safely and clamped", () => {
  const settings = normalizeSettings({
    ...defaultSettings,
    workspaceTerminalPreferences: {
      fontFamily: "jetbrains",
      fontSize: 99,
      lineHeight: "0.2",
      colorScheme: "high-contrast",
      scrollback: 999999,
      cursorStyle: "underline",
      screenReaderMode: true,
      confirmLargePaste: false
    }
  });

  expect(settings.workspaceTerminalPreferences).toEqual({
    fontFamily: "jetbrains",
    fontSize: 24,
    lineHeight: "1.00",
    colorScheme: "high-contrast",
    scrollback: 20000,
    cursorStyle: "underline",
    screenReaderMode: true,
    confirmLargePaste: false
  });
  expect(workspaceTerminalPreferences(settings)).toMatchObject({ lineHeight: 1, confirmLargePaste: false });
});

test("Workspace terminal preferences use safe defaults for an old settings payload", () => {
  const settings = normalizeSettings({ theme: "dark" });
  expect(settings.workspaceTerminalPreferences).toEqual(defaultSettings.workspaceTerminalPreferences);
});
