import { expect, test } from "vitest";
import source from "./XtermTerminal.tsx?raw";

test("Unicode11 renderer enables the required xterm proposed API", () => {
  expect(source).toContain("allowProposedApi: true");
  expect(source).toContain('terminal.unicode.activeVersion = "11"');
  expect(source).not.toContain("ClipboardAddon");
  expect(source).not.toContain("WebLinksAddon");
});

test("renderer failures use stable identifiers and do not forward the raw exception", () => {
  expect(source).toContain("onRendererErrorRef.current({");
  expect(source).toContain("sessionId: session.sessionId");
  expect(source).toContain("retry: rendererRetry");
  expect(source).not.toContain("onRendererErrorRef.current(error)");
  const start = source.indexOf("}).catch(() => {");
  const end = source.indexOf("\n    });", start);
  const rendererCatch = source.slice(start, end);
  expect(rendererCatch).not.toContain("onErrorRef.current");
});

test("toolbar events control search, focus, and selection copy without mirroring terminal bytes", () => {
  expect(source).toContain("WORKSPACE_TERMINAL_SEARCH_EVENT");
  expect(source).toContain("WORKSPACE_TERMINAL_FOCUS_EVENT");
  expect(source).toContain("WORKSPACE_TERMINAL_COPY_EVENT");
  expect(source).toContain("terminal.getSelection()");
  expect(source).toContain("latestSequenceRef");
  expect(source).toContain("terminal.write(base64ToBytes(frame.dataBase64)");
  expect(source).not.toContain("setTerminalOutput");
});

test("terminal theme resolves from its own persistent preference and never reads the app or system theme", () => {
  expect(source).toContain('export type TerminalThemeOverride = "preferences" | "dark" | "light" | "high-contrast"');
  expect(source).toContain('themeOverride = "preferences"');
  expect(source).toContain('return preference === "light" || preference === "high-contrast" ? preference : "dark"');
  expect(source).toContain("data-terminal-theme={resolvedThemeMode}");
  expect(source).not.toContain("document.documentElement.dataset.theme");
  expect(source).not.toContain("prefers-color-scheme");
});
