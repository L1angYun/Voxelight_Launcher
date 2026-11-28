// @vitest-environment node
// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETUP_LOCALES } from "./index";

const localeRoot = fileURLToPath(new URL("./locales/", import.meta.url));
const INSTALLER_FLAG = /(?:^|\s)\/(?:S|P|UPDATE|R|NS|NCRC|ARGS)\b|(?:^|\s)\/D=/i;

function values(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(values);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(values);
  }
  return [];
}

describe("setup locale copy", () => {
  it("never shows installer command-line flags or middle-dot separators", () => {
    for (const locale of SETUP_LOCALES) {
      const file = path.join(localeRoot, `${locale}.json`);
      const json = JSON.parse(readFileSync(file, "utf8")) as unknown;
      for (const value of values(json)) {
        expect(value, `${locale}: ${value}`).not.toMatch(INSTALLER_FLAG);
        expect(value, `${locale}: ${value}`).not.toContain("·");
      }
    }
  });

  it("describes the shortcut choice without naming any installer flag", () => {
    for (const locale of SETUP_LOCALES) {
      const file = path.join(localeRoot, `${locale}.json`);
      const json = JSON.parse(readFileSync(file, "utf8")) as {
        options: { shortcutsHint: string };
      };
      expect(json.options.shortcutsHint, locale).not.toMatch(/\/[A-Z]+/);
      expect(json.options.shortcutsHint.length, locale).toBeGreaterThan(20);
    }
  });
});
