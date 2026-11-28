import type { TFunction } from "i18next";
import type { Instance } from "../../lib/launcher";
import { formatBytes } from "../../i18n/format";
import { localizedErrorParams } from "../../lib/errorReasons";

export function errorText(code: string, t: TFunction, params?: Record<string, unknown>): string {
  return t(`shell:errors.${code}`, {
    ...localizedErrorParams(code, params, t),
    defaultValue: t("common:errors.internalUnexpected"),
  });
}

export function noticeText(code: string, t: TFunction, params?: Record<string, unknown>): string {
  return t(`library:notice.${code}`, params);
}

const LOADER_NAMES: Record<string, string> = { fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge", optifine: "OptiFine" };

/** Display name of a loader id; vanilla (or no loader) is translated, the rest are product names. */
export function loaderDisplayName(loader: string | null | undefined, t: TFunction): string {
  if (!loader || loader.toLowerCase() === "vanilla") return t("library:vanilla");
  return LOADER_NAMES[loader.toLowerCase()] ?? loader;
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
