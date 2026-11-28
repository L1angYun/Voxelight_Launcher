import type { TFunction } from "i18next";

/**
 * Some backend errors carry a stable reason code in their `reason` parameter
 * instead of text. The interface translates the code before the message is
 * built, so no locale ever shows Chinese system text or a raw code name.
 */
const RECYCLE_REASONS = [
  "networkShare",
  "noRecycleBin",
  "unknownDrive",
  "pathTooLong",
  "unsupportedPath",
  "unsupportedSystem",
  "shellError",
  "aborted",
] as const;
const INSTANCE_ISSUES = [
  "baseMissing",
  "clientJarMissing",
  "invalidMainClass",
  "loaderDamaged",
  "metadataInvalid",
] as const;
const GAME_FOLDER_REASONS = ["invalidPath", "openFailed"] as const;

function oneOf<T extends string>(choices: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (choices as readonly string[]).includes(value);
}

/** The parameters of a backend error with any reason code translated. */
export function localizedErrorParams(
  code: string,
  params: Record<string, unknown> | undefined,
  t: TFunction,
): Record<string, unknown> {
  const values: Record<string, unknown> = { ...params };
  const reason = values.reason;
  switch (code) {
    case "instance.recycleUnavailable":
    case "instance.recycleFailed":
      values.reason = oneOf(RECYCLE_REASONS, reason)
        ? t(`shell:errorReasons.recycle.${reason}`, { code: values.code ?? "" })
        : t("shell:errorReasons.recycle.unknown");
      break;
    case "instance.launchBlocked":
      values.reason = oneOf(INSTANCE_ISSUES, reason)
        ? t(`library:instanceIssue.${reason}`)
        : t("library:instanceIssue.metadataInvalid");
      break;
    case "gameFolder.unavailable":
      values.reason = oneOf(GAME_FOLDER_REASONS, reason)
        ? t(`shell:errorReasons.gameFolder.${reason}`)
        : t("shell:errorReasons.gameFolder.openFailed");
      break;
    default:
      break;
  }
  return values;
}
