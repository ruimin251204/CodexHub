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
