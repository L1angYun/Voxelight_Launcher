// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from "node:fs";
import { parse, type AtRule, type Node } from "postcss";
import { describe, expect, it } from "vitest";

// R9 ui-language-spec §3.2 single field ring: an indicator border, a 1px
// --field-focus spread, and a transparent 2px outline inset by 2px. Box shadows
// disappear in forced colors; the transparent outline is what stays visible.
// jsdom cannot paint :focus-visible, so the declared rules are checked here.
function focusRule(file: string, selector: string) {
  const found: Record<string, string>[] = [];
  parse(readFileSync(file, "utf8")).walkRules(rule => {
    if (!rule.selectors.map(value => value.trim()).includes(selector)) return;
    for (let node = rule.parent as Node | undefined; node; node = node.parent as Node | undefined)
      if (node.type === "atrule" && /forced-colors/.test((node as AtRule).params)) return;
    const values: Record<string, string> = {};
    rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
    found.push(values);
  });
  expect(found, `${selector} in ${file}`).toHaveLength(1);
  return found[0];
}

describe("single field focus ring", () => {
  it.each([
    ["src/features/library/create-instance.css", ".vx-create-version-well:has(.vx-create-version-list:focus-visible)"],
    ["src/components/ui/AnchoredListbox.css", ".vx-select--flat:has(.vx-select__button:focus-visible) .vx-select__surface"],
  ])("%s keeps the forced-colors fallback outline on the painted ring", (file, selector) => {
    const ring = focusRule(file, selector);
    expect(ring["border-color"]).toBe("var(--accent-indicator)");
    expect(ring["box-shadow"]).toMatch(/^var\(--field-focus(?:, 0 0 0 1px var\(--accent-indicator\))?\)$/);
    expect(ring.outline).toBe("2px solid transparent");
    expect(ring["outline-offset"]).toMatch(/^var\(--focus-ring-offset-inset(?:, -2px)?\)$/);
  });
});
