import { describe, expect, it } from "vitest";
import { createLauncherI18n, SUPPORTED_LOCALES } from "../i18n";
import { errorText } from "../features/library/utils";
import { normalizeError } from "./errors";
import { localizedErrorParams } from "./errorReasons";

const HAN = /[一-鿿]/;

async function launcherT(locale: string) {
  const i18n = createLauncherI18n(locale, "en-US");
  await i18n.initPromise;
  return i18n.t;
}

describe("backend reason codes", () => {
  it("are translated in every locale before the message is built", async () => {
    // The exact errors the backend sends: a reason code, never text.
    const errors = [
      { code: "instance.recycleUnavailable", params: { reason: "pathTooLong" } },
      { code: "instance.recycleFailed", params: { reason: "shellError", code: "0x7C" } },
      { code: "instance.launchBlocked", params: { reason: "metadataInvalid" } },
      { code: "gameFolder.unavailable", params: { reason: "invalidPath" } },
    ].map((error) => normalizeError(error));
    for (const locale of SUPPORTED_LOCALES) {
      const t = await launcherT(locale);
      for (const error of errors) {
        const text = errorText(error.code, t, error.params);
        expect(text, `${locale} ${error.code}`).not.toContain(String(error.params.reason));
        expect(text, `${locale} ${error.code}`).not.toContain("{{");
        expect(text, `${locale} ${error.code}`).not.toContain("errorReasons");
        if (!locale.startsWith("zh") && locale !== "ja-JP") {
          expect(text, `${locale} ${error.code}`).not.toMatch(HAN);
        }
      }
      expect(errorText(errors[1].code, t, errors[1].params), locale).toContain("0x7C");
    }
  });

  it("read as one sentence in English", async () => {
    const t = await launcherT("en-US");
    expect(errorText("instance.recycleUnavailable", t, { reason: "pathTooLong" })).toBe(
      "This folder cannot be moved to the Recycle Bin: its path is too long for the Recycle Bin. Nothing was deleted. Use the separately confirmed permanent delete if you want to remove the folder.",
    );
    expect(errorText("instance.recycleFailed", t, { reason: "shellError", code: "0x7C" })).toBe(
      "The folder could not be moved to the Recycle Bin: Windows reported error 0x7C. Nothing was deleted.",
    );
    expect(errorText("instance.launchBlocked", t, { reason: "loaderDamaged" })).toBe(
      "This instance cannot be launched. The loader profile is damaged. Reinstall the same loader in the Launcher.",
    );
    expect(errorText("gameFolder.unavailable", t, { reason: "openFailed" })).toBe(
      "The game folder could not be opened: the system could not open it",
    );
  });

  it("never pass an unknown reason through as text", async () => {
    const t = await launcherT("en-US");
    // An older backend or a future code: the message stays in the locale.
    const recycle = localizedErrorParams("instance.recycleFailed", { reason: "拒绝访问" }, t);
    expect(recycle.reason).toBe("an unexpected error occurred");
    const blocked = localizedErrorParams("instance.launchBlocked", { reason: "somethingNew" }, t);
    expect(blocked.reason).toBe(t("library:instanceIssue.metadataInvalid"));
    // Other errors keep their parameters untouched.
    expect(localizedErrorParams("instance.running", { id: "x" }, t)).toEqual({ id: "x" });
  });
});
