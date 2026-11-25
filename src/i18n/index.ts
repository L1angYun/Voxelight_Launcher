import { createInstance, type i18n } from "i18next";

export const SUPPORTED_LOCALES = [
  "zh-CN",
  "zh-TW",
  "en-US",
  "ja-JP",
  "ko-KR",
  "ru-RU",
  "es-ES",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type LauncherI18n = i18n & { initPromise: Promise<unknown> };

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  "en-US": "English",
  "ja-JP": "日本語",
  "ko-KR": "한국어",
  "ru-RU": "Русский",
  "es-ES": "Español",
};

const MISSING_CONTENT_FALLBACK: Record<SupportedLocale, string> = {
  "zh-CN": "无法显示此内容。",
  "zh-TW": "無法顯示此內容。",
  "en-US": "This content cannot be displayed.",
  "ja-JP": "この内容を表示できません。",
  "ko-KR": "이 콘텐츠를 표시할 수 없습니다.",
  "ru-RU": "Не удалось отобразить это содержимое.",
  "es-ES": "No se puede mostrar este contenido.",
};

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
  const normalized = systemLocale.trim().toLowerCase().replaceAll("_", "-");
  if (
    normalized === "zh-hant"
    || normalized === "zh-tw"
    || normalized === "zh-hk"
    || normalized === "zh-mo"
    || normalized.startsWith("zh-hant-")
  ) {
    return "zh-TW";
  }
  if (
    normalized === "zh"
    || normalized === "zh-hans"
    || normalized === "zh-cn"
    || normalized === "zh-sg"
    || normalized.startsWith("zh-hans-")
  ) {
    return "zh-CN";
  }
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja-JP";
  if (normalized === "ko" || normalized.startsWith("ko-")) return "ko-KR";
  if (normalized === "ru" || normalized.startsWith("ru-")) return "ru-RU";
  if (normalized === "es" || normalized.startsWith("es-")) return "es-ES";
  return "en-US";
}

export function resolveLocale(preference: string, systemLocale: string): SupportedLocale {
  if ((SUPPORTED_LOCALES as readonly string[]).includes(preference)) {
    return preference as SupportedLocale;
  }
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
    supportedLngs: [...SUPPORTED_LOCALES],
    nonExplicitSupportedLngs: false,
    load: "currentOnly",
    resources,
    ns: Object.keys(resources[locale] ?? resources["en-US"] ?? { common: {} }),
    defaultNS: "common",
    fallbackNS: "common",
    returnEmptyString: false,
    returnNull: false,
    // React escapes every rendered string; escaping here as well would show
    // paths and names as &#x2F; and &amp; (nothing renders translations as HTML).
    interpolation: { escapeValue: false },
    saveMissing: false,
    parseMissingKeyHandler: (_key, defaultValue) => {
      const active = (SUPPORTED_LOCALES as readonly string[]).includes(instance.language)
        ? (instance.language as SupportedLocale)
        : "en-US";
      return defaultValue ?? MISSING_CONTENT_FALLBACK[active];
    },
    react: { useSuspense: false },
  });
  return Object.assign(instance, { initPromise });
}
