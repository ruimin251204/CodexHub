import { expect, test } from "vitest";
import appSource from "../App.tsx?raw";

test("Workspace remains outside the non-Workspace initial module boundary", () => {
  expect(appSource).toMatch(/const WorkspacePage = lazy\(async \(\) => \{/);
  expect(appSource).toContain('import("./workspace/WorkspacePage")');
  expect(appSource).not.toMatch(/^import\s+\{\s*WorkspacePage\s*\}\s+from\s+["']\.\/workspace\/WorkspacePage["'];?$/m);
  expect(appSource).toContain("<Suspense fallback=");
});

test("safe no-replace failures retain a specific bilingual safety explanation", () => {
  const noOverwriteZh = String.fromCodePoint(0x6587, 0x4ef6, 0x672a, 0x88ab, 0x8986, 0x76d6);
  expect(appSource).toContain('normalized.includes("safe-no-replace-unsupported")');
  expect(appSource).toContain("return copy.feedback.safeNoReplaceUnsupported;");
  expect(appSource).toContain("No file was overwritten");
  expect(appSource).toContain(noOverwriteZh);
});
