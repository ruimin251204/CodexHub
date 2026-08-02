import { describe, expect, test } from "vitest";
import { uiCopy } from "../App";
import { searchGlobalEntries } from "./globalSearch";
import { createGlobalSearchCatalog } from "./globalSearchCatalog";

describe("CodexHub global search catalog", () => {
  test.each(["API", "API配置", "Provider", "接口", "密钥"])("maps %s to profiles", (query) => {
    expect(searchGlobalEntries(query, createGlobalSearchCatalog(uiCopy.zh))[0]).toMatchObject({ section: "profiles" });
  });

  test.each(["skill", "skills", "plugin", "插件"])("maps %s to skills", (query) => {
    expect(searchGlobalEntries(query, createGlobalSearchCatalog(uiCopy.zh))[0]).toMatchObject({ section: "skills" });
  });

  test.each([
    ["外观", "settings-appearance"],
    ["主题", "settings-theme"],
    ["字体", "settings-font"],
    ["字号", "settings-terminal-font-size"],
    ["配色", "settings-terminal-colors"]
  ])("maps %s to its precise settings target", (query, targetId) => {
    expect(searchGlobalEntries(query, createGlobalSearchCatalog(uiCopy.zh))[0]).toMatchObject({
      section: "settings",
      targetId
    });
  });

  test("keeps Chinese settings aliases searchable in English UI", () => {
    expect(searchGlobalEntries("开机自启", createGlobalSearchCatalog(uiCopy.en))[0]).toMatchObject({
      section: "settings",
      targetId: "settings-launch-at-login"
    });
  });
});
