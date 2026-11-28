// SPDX-License-Identifier: GPL-3.0-only
import { createInstance, type i18n } from "i18next";
import enUS from "./locales/en-US.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";
import jaJP from "./locales/ja-JP.json";
import koKR from "./locales/ko-KR.json";
import ruRU from "./locales/ru-RU.json";
import esES from "./locales/es-ES.json";

export const SETUP_LOCALES = [
  "en-US",
  "zh-CN",
  "zh-TW",
  "ja-JP",
  "ko-KR",
  "ru-RU",
  "es-ES",
] as const;

export type SetupLocale = (typeof SETUP_LOCALES)[number];

const RESOURCES = {
  "en-US": { setup: enUS },
  "zh-CN": { setup: zhCN },
  "zh-TW": { setup: zhTW },
  "ja-JP": { setup: jaJP },
  "ko-KR": { setup: koKR },
  "ru-RU": { setup: ruRU },
  "es-ES": { setup: esES },
} as const;

export function resolveSetupLocale(locale: string | null | undefined): SetupLocale {
  const normalized = (locale ?? "").trim().toLowerCase().replaceAll("_", "-");
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

export function createSetupI18n(initialLocale: string | null | undefined): i18n {
  const lng = resolveSetupLocale(initialLocale);
  const instance = createInstance();
  void instance.init({
    lng,
    fallbackLng: "en-US",
    supportedLngs: [...SETUP_LOCALES],
    nonExplicitSupportedLngs: false,
    load: "currentOnly",
    resources: RESOURCES,
    ns: ["setup"],
    defaultNS: "setup",
    fallbackNS: "setup",
    returnEmptyString: false,
    returnNull: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return instance;
}
