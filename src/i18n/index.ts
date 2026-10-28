import { createInstance, type i18n } from "i18next";

export type SupportedLocale = "zh-CN" | "en-US";
export type LauncherI18n = i18n & { initPromise: Promise<unknown> };

type TranslationTree = { [key: string]: string | TranslationTree };

const localeModules = import.meta.glob("./locales/*/*.json", {
  eager: true,
  import: "default",
});

function pseudoTree(tree: TranslationTree): TranslationTree {
  return Object.fromEntries(Object.entries(tree).map(([key, value]) => [
    key,
    typeof value === "string"
      ? `⟦${value} ${"▧".repeat(Math.max(2, Math.ceil(value.length * 0.75)))}⟧`
      : pseudoTree(value),
  ]));
}

function bundledResources(pseudoLocale = false) {
  const resources: Record<string, Record<string, TranslationTree>> = {};
  for (const [path, value] of Object.entries(localeModules)) {
    const match = path.match(/^\.\/locales\/([^/]+)\/([^/]+)\.json$/);
    if (!match) continue;
    const [, locale, namespace] = match;
    (resources[locale] ??= {})[namespace] = pseudoLocale ? pseudoTree(value as TranslationTree) : value as TranslationTree;
  }
  return resources;
}

function systemLocaleToSupported(systemLocale: string): SupportedLocale {
  const normalized = systemLocale.toLowerCase();
  return normalized === "zh-hans" ||
    normalized === "zh-cn" ||
    normalized === "zh-sg" ||
    normalized.startsWith("zh-hans-")
    ? "zh-CN"
    : "en-US";
}

export function resolveLocale(preference: string, systemLocale: string): SupportedLocale {
  if (preference === "zh-CN" || preference === "en-US") return preference;
  if (preference === "system") return systemLocaleToSupported(systemLocale);
  return "en-US";
}

export function createLauncherI18n(preference: string, systemLocale: string, pseudoLocale = false): LauncherI18n {
  const locale = resolveLocale(preference, systemLocale);
  const resources = bundledResources(pseudoLocale);
  const instance = createInstance();
  const initPromise = instance.init({
    lng: locale,
    fallbackLng: "en-US",
    supportedLngs: ["zh-CN", "en-US"],
    nonExplicitSupportedLngs: false,
    load: "currentOnly",
    resources,
    ns: Object.keys(resources[locale] ?? resources["en-US"] ?? { common: {} }),
    defaultNS: "common",
    fallbackNS: "common",
    returnEmptyString: false,
    returnNull: false,
    saveMissing: false,
    parseMissingKeyHandler: (_key, defaultValue) =>
      defaultValue ?? (instance.language === "zh-CN" ? "无法显示此内容。" : "This content cannot be displayed."),
    react: { useSuspense: false },
  });
  return Object.assign(instance, { initPromise });
}
