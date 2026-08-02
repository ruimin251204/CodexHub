import { describe, expect, test } from "vitest";
import {
  normalizeGlobalSearchText,
  searchGlobalEntries,
  tokenizeGlobalSearchQuery,
  type GlobalSearchEntry
} from "./globalSearch";

const entries = [
  {
    id: "section:profiles",
    label: "配置",
    detail: "Codex API 配置",
    section: "profiles",
    keywords: ["API", "API config", "profile", "configuration"]
  },
  {
    id: "section:skills",
    label: "技能",
    detail: "本地技能库",
    section: "skills",
    keywords: ["skill", "skills", "plugin"]
  },
  {
    id: "settings:theme",
    label: "主题",
    detail: "设置 · 外观",
    section: "settings",
    targetId: "settings-theme",
    keywords: ["theme", "appearance", "dark", "light"]
  },
  {
    id: "settings:font",
    label: "字体",
    detail: "设置 · 外观",
    section: "settings",
    targetId: "settings-font",
    keywords: ["font", "typeface"]
  }
] as const satisfies readonly GlobalSearchEntry[];

describe("global search normalization", () => {
  test("normalizes compatibility characters, case, and whitespace", () => {
    expect(normalizeGlobalSearchText("  ＡＰＩ\t CONFIG  ")).toBe("api config");
    expect(tokenizeGlobalSearchQuery("  API\n  配置 ")).toEqual(["api", "配置"]);
  });
});

describe("searchGlobalEntries", () => {
  test("finds Chinese destinations through English aliases", () => {
    expect(searchGlobalEntries("API", entries)[0]).toMatchObject({ id: "section:profiles", section: "profiles" });
    expect(searchGlobalEntries("skill", entries)[0]).toMatchObject({ id: "section:skills", section: "skills" });
    expect(searchGlobalEntries("theme", entries)[0]).toMatchObject({ id: "settings:theme", targetId: "settings-theme" });
  });

  test("requires every token to match somewhere in the same entry", () => {
    expect(searchGlobalEntries("API 配置", entries).map((entry) => entry.id)).toEqual(["section:profiles"]);
    expect(searchGlobalEntries("API 技能", entries)).toEqual([]);
  });

  test("ranks exact matches before prefixes and prefixes before containment", () => {
    const rankedEntries: GlobalSearchEntry[] = [
      { id: "contains", label: "My API tools", detail: "", section: "one" },
      { id: "prefix", label: "API tools", detail: "", section: "two" },
      { id: "exact", label: "API", detail: "", section: "three" }
    ];

    expect(searchGlobalEntries("api", rankedEntries).map((entry) => entry.id)).toEqual(["exact", "prefix", "contains"]);
  });

  test("keeps input order for equal scores, keeps the first duplicate, and applies the total limit", () => {
    const tiedEntries = [
      { id: "first", label: "Alpha", detail: "", section: "one", marker: 1 },
      { id: "duplicate", label: "Alpha", detail: "", section: "two", marker: 2 },
      { id: "duplicate", label: "Alpha", detail: "", section: "three", marker: 3 },
      { id: "last", label: "Alpha", detail: "", section: "four", marker: 4 }
    ];

    const results = searchGlobalEntries("alpha", tiedEntries, 3);
    expect(results.map((entry) => entry.id)).toEqual(["first", "duplicate", "last"]);
    expect(results[1].marker).toBe(2);
  });

  test("uses priority as an explicit ranking adjustment and handles empty limits", () => {
    const priorityEntries: GlobalSearchEntry[] = [
      { id: "normal", label: "Settings", detail: "", section: "settings" },
      { id: "preferred", label: "Settings", detail: "", section: "settings", priority: 25 }
    ];

    expect(searchGlobalEntries("settings", priorityEntries)[0].id).toBe("preferred");
    expect(searchGlobalEntries("settings", priorityEntries, 0)).toEqual([]);
    expect(searchGlobalEntries("   ", priorityEntries)).toEqual([]);
  });
});
