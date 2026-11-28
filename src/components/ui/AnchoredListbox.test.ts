// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const listboxCss = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "AnchoredListbox.css"), "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function declarations(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(listboxCss);
  if (!match) throw new Error(`Missing rule ${selector}`);
  return match[1];
}

describe("select trigger spacing", () => {
  it("separates the icon, value and chevron with the related gap", () => {
    // The trigger gap was 10px before R9. The spacing scale rounds a 10px gap to
    // 8px (--gap-related, icon and text), so the home instance picker keeps its
    // text width when its icon column grows from 18px to ICON.lg (20px).
    const trigger = declarations(".vx-select__button");
    expect(trigger).toMatch(/(?:^|[;\s])gap:\s*var\(--gap-related\);/);
    expect(trigger).toMatch(/grid-template-columns:\s*minmax\(0,1fr\) var\(--icon-md, 16px\);/);
    expect(declarations('.vx-select__button[data-has-icon="true"]'))
      .toMatch(/grid-template-columns:\s*var\(--icon-lg, 20px\) minmax\(0,1fr\) var\(--icon-md, 16px\);/);
  });
});
