import type { TFunction } from "i18next";
import { normalizeError } from "../../lib/errors";

export function accountErrorCodeText(code: string, t: TFunction): string {
  return t(`accounts:errors.${code}`, {
    defaultValue: t("common:errors.internalUnexpected"),
  });
}

export function accountErrorText(cause: unknown, t: TFunction): string {
  return accountErrorCodeText(normalizeError(cause).code, t);
}
