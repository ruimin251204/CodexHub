import { describe, expect, test } from "vitest";
import {
  MONITOR_UNKNOWN_GPU_USER,
  assignMonitorGpuUserColors
} from "./gpuUserColors";

const LIGHT_SURFACE = "#ffffff";
const DARK_SURFACE_MUTED = "#343434";

describe("GPU user colors", () => {
  test("keeps cjj and generated overflow colors vivid and visible on both themes", () => {
    const users = ["cjj", ...Array.from({ length: 64 }, (_, index) => `user-${index}`)];
    const colors = assignMonitorGpuUserColors(users);

    for (const user of users) {
      const color = colors.get(user);
      expect(color, user).toMatch(/^#[0-9a-f]{6}$/);
      expect(rgbSpread(color!), user).toBeGreaterThanOrEqual(48);
      expect(contrastRatio(color!, LIGHT_SURFACE), `${user} on light`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(color!, DARK_SURFACE_MUTED), `${user} on dark`).toBeGreaterThanOrEqual(3);
    }
  });

  test("keeps assignments stable and reserves a visible color for unknown users", () => {
    const forward = assignMonitorGpuUserColors(["cjj", "amax", MONITOR_UNKNOWN_GPU_USER]);
    const reverse = assignMonitorGpuUserColors([MONITOR_UNKNOWN_GPU_USER, "amax", "cjj"]);

    expect(Array.from(forward.entries())).toEqual(Array.from(reverse.entries()));
    expect(forward.get("cjj")).not.toBe("#52525b");
    expect(forward.get(MONITOR_UNKNOWN_GPU_USER)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function relativeLuminance(color: string) {
  const channels = hexChannels(color).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function rgbSpread(color: string) {
  const channels = hexChannels(color);
  return Math.max(...channels) - Math.min(...channels);
}

function hexChannels(color: string) {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
}
