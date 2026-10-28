import type { TFunction } from "i18next";
import type { Instance } from "../../lib/launcher";
import { formatBytes } from "../../i18n/format";

export function errorText(code: string, t: TFunction): string {
  return t(`shell:errors.${code}`, { defaultValue: t("common:errors.internalUnexpected") });
}

export function noticeText(code: string, t: TFunction, params?: Record<string, unknown>): string {
  return t(`library:notice.${code}`, params);
}

export function sizeText(bytes: number, locale: string): string {
  return formatBytes(bytes, locale);
}

export function loaderText(instance: Pick<Instance, "loader" | "loaderVersion">, t: TFunction): string {
  const loader = !instance.loader || instance.loader === "vanilla"
    ? t("library:vanilla")
    : instance.loader;
  return instance.loaderVersion ? `${loader} ${instance.loaderVersion}` : loader;
}
