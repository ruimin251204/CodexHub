import { describe, expect, it } from "vitest";
import { defaultSettings, normalizeSettings } from "./settings";

describe("personal information masking settings", () => {
  it("is enabled for new and legacy settings", () => {
    expect(defaultSettings.personalInfoMasking).toBe(true);
    expect(normalizeSettings({}).personalInfoMasking).toBe(true);
  });

  it("preserves an explicit opt-out", () => {
    expect(normalizeSettings({ personalInfoMasking: false }).personalInfoMasking).toBe(false);
  });
});
