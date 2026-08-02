import { expect, test } from "vitest";
import { formatSessionDuration } from "./TerminalStatusBar";

test("session duration is derived from createdAt", () => {
  expect(formatSessionDuration("2026-08-01T00:00:00.000Z", Date.parse("2026-08-01T01:02:03.000Z"))).toBe("01:02:03");
});

test("invalid or future timestamps remain safe", () => {
  expect(formatSessionDuration("invalid", Date.now())).toBe("--:--:--");
  expect(formatSessionDuration("2026-08-01T01:00:00.000Z", Date.parse("2026-08-01T00:00:00.000Z"))).toBe("00:00:00");
});

