import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLauncherI18n, type LauncherI18n } from "../../i18n";
import { searchSettings, settingsIndex, type SettingsSectionId } from "./settingsIndex";

const locales = ["en-US", "zh-CN"] as const;
const sectionIds: readonly SettingsSectionId[] = ["general", "appearance", "game", "java", "downloads", "about"];
const sectionSources: Record<SettingsSectionId, string[]> = {
  general: ["./GeneralSettings.tsx"],
  appearance: ["./AppearanceSettings.tsx"],
  game: ["./GameSettings.tsx"],
  java: ["./JavaSettings.tsx"],
  downloads: ["./DownloadSettings.tsx", "./ProxySettings.tsx"],
  about: ["./AboutSettings.tsx", "./UpdateSettings.tsx"],
};

function readLocale(locale: (typeof locales)[number]): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../i18n/locales/${locale}/settings.json`, import.meta.url)), "utf8"));
}

function hasKey(tree: Record<string, unknown>, qualifiedKey: string): boolean {
  let node: unknown = tree;
  for (const part of qualifiedKey.replace(/^settings:/, "").split(".")) {
    if (!node || typeof node !== "object" || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" && node.trim().length > 0;
}

async function translator(locale: (typeof locales)[number]): Promise<{ i18n: LauncherI18n; t: (key: string) => string }> {
  const i18n = createLauncherI18n(locale, locale);
  await i18n.initPromise;
  return { i18n, t: (key: string) => i18n.t(key) };
}

describe("settings search index", () => {
  it("keeps every label and keyword available in both locales", () => {
    const trees = Object.fromEntries(locales.map((locale) => [locale, readLocale(locale)])) as Record<(typeof locales)[number], Record<string, unknown>>;
    for (const entry of settingsIndex) {
      expect(entry.labelKey, entry.target).toMatch(/^settings:/);
      for (const locale of locales) expect(hasKey(trees[locale], entry.labelKey), `${locale} ${entry.labelKey}`).toBe(true);
      for (const keyword of entry.keywords ?? []) {
        expect(keyword, entry.target).toMatch(/^settings:search\.keywords\./);
        for (const locale of locales) expect(hasKey(trees[locale], keyword), `${locale} ${keyword}`).toBe(true);
      }
    }
  });

  it("uses only valid settings section ids", () => {
    for (const entry of settingsIndex) expect(sectionIds, entry.target).toContain(entry.section);
  });

  it("keeps every target and fallback present in the section component sources", () => {
    for (const entry of settingsIndex) {
      const sources = sectionSources[entry.section]
        .map((file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"));
      for (const target of [entry.target, ...(entry.fallbackTarget ? [entry.fallbackTarget] : [])]) {
        expect(sources.join("\n"), `${entry.section} -> ${target}`)
          .toContain(`data-settings-target="${target}"`);
      }
    }
  });

  it("matches labels case-insensitively and ignores surrounding spaces", async () => {
    const { t } = await translator("en-US");
    expect(searchSettings("  mEmOrY ", t).map((result) => result.entry.target))
      .toEqual(searchSettings("memory", t).map((result) => result.entry.target));
    expect(searchSettings("  mEmOrY ", t).length).toBeGreaterThan(0);
  });

  it("orders label-prefix matches before other matches", async () => {
    const { t } = await translator("en-US");
    const results = searchSettings("java", t);
    const prefixFlags = results.map((result) => result.label.toLowerCase().startsWith("java"));
    expect(prefixFlags.some(Boolean)).toBe(true);
    expect(prefixFlags.some((prefix) => !prefix)).toBe(true);
    expect(prefixFlags).toEqual([...prefixFlags].sort((a, b) => Number(b) - Number(a)));
    expect(results[0].entry.target).toBe("java-executable");
  });

  it("returns at most eight results", async () => {
    const { t } = await translator("en-US");
    const results = searchSettings("a", t);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(8);
  });

  it("returns nothing for an empty or whitespace-only query", async () => {
    const { t } = await translator("en-US");
    expect(searchSettings("", t)).toEqual([]);
    expect(searchSettings("   ", t)).toEqual([]);
  });

  it("finds a setting through a keyword synonym in both languages", async () => {
    const english = await translator("en-US");
    const chinese = await translator("zh-CN");
    expect(searchSettings("RAM", english.t).some((result) => result.entry.target === "java-max-memory")).toBe(true);
    expect(searchSettings("运行内存", chinese.t).some((result) => result.entry.target === "java-max-memory")).toBe(true);
  });

  it("indexes the memory allocation mode under the placeholder search examples", async () => {
    const english = await translator("en-US");
    const chinese = await translator("zh-CN");
    for (const query of ["memory", "memory allocation"]) {
      expect(searchSettings(query, english.t).some((result) => result.entry.target === "java-memory-mode"), query).toBe(true);
    }
    for (const query of ["内存", "内存分配"]) {
      expect(searchSettings(query, chinese.t).some((result) => result.entry.target === "java-memory-mode"), query).toBe(true);
    }
  });

  it("matches the state-dependent optional Microsoft Client ID label", async () => {
    const english = await translator("en-US");
    const chinese = await translator("zh-CN");
    for (const { t } of [english, chinese]) {
      expect(searchSettings("Microsoft Client ID", t).some((result) => result.entry.target === "general-client-id")).toBe(true);
    }
  });
});
