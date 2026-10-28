import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createLauncherI18n, resolveLocale } from "./index";
import { formatBytes, formatDate, formatNumber } from "./format";

function localeKeys(path: string): string[] {
  const value = JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
  const keys: string[] = [];
  const visit = (node: unknown, prefix = "") => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      keys.push(prefix);
      return;
    }
    for (const [key, child] of Object.entries(node)) visit(child, prefix ? `${prefix}.${key}` : key);
  };
  visit(value);
  return keys.sort();
}

describe("launcher i18n", () => {
  it("maps system and unsupported locales to supported languages", () => {
    expect(resolveLocale("system", "zh-SG")).toBe("zh-CN");
    expect(resolveLocale("system", "zh-Hans-CN")).toBe("zh-CN");
    expect(resolveLocale("system", "fr-FR")).toBe("en-US");
    expect(resolveLocale("en-US", "zh-CN")).toBe("en-US");
  });

  it("loads bundled translations without a network request and falls back safely", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const chinese = createLauncherI18n("system", "zh-CN");
    const english = createLauncherI18n("system", "fr-FR");
    await Promise.all([chinese.initPromise, english.initPromise]);
    expect(chinese.language).toBe("zh-CN");
    expect(english.language).toBe("en-US");
    expect(chinese.t("actions.launch")).toBe("启动游戏");
    expect(english.t("actions.launch")).toBe("Launch game");
    expect(english.t("missing.key")).not.toBe("missing.key");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps both locale key sets identical", () => {
    expect(localeKeys("./locales/zh-CN/common.json")).toEqual(
      localeKeys("./locales/en-US/common.json"),
    );
  });

  it("formats numbers, dates, and bytes with the requested locale", () => {
    expect(formatNumber(1234567, "en-US")).toBe("1,234,567");
    expect(formatDate("2026-10-26T00:00:00Z", "en-US")).toBe("Oct 26, 2026");
    expect(formatBytes(1024, "en-US")).toBe("1 KiB");
    expect(formatBytes(1024 * 1024, "zh-CN")).toBe("1 MiB");
  });
});
