import { readFileSync } from "node:fs";
import { parse, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/features/multiplayer/multiplayer.css", "utf8");
const sheet = parse(css);

/** The unconditional declarations for `selector` exactly as written in one of its rule's selector lists. */
function declarations(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  sheet.walkRules((rule: Rule) => {
    const parent = rule.parent?.type === "atrule" ? (rule.parent as { name?: string }).name : undefined;
    if (parent === "media" || parent === "container") return;
    if (!rule.selectors.map(item => item.replace(/\s+/g, " ").trim()).includes(selector)) return;
    rule.walkDecls(declaration => { found.set(declaration.prop, declaration.value); });
  });
  return found;
}

describe("multiplayer stylesheet", () => {
  it("sets the saved-server count in the UI face as a small tabular figure, not Doto", () => {
    const count = declarations(".vx-server-inventory__count");
    expect(count.get("font")).toBe("var(--type-meta)");
    expect(count.get("font-variant-numeric")).toBe("tabular-nums");
    expect(count.get("color")).toBe("var(--text-tertiary)");
    expect(css).not.toMatch(/--font-matrix|--text-matrix-count/);
  });

  it("separates LAN discovery with a rule and a label-level title", () => {
    expect(declarations(".vx-lan-section").get("border-top")).toBe("var(--rule)");
    const title = declarations(".vx-lan-section > header h2");
    expect(title.get("font")).toBe("var(--type-label)");
    expect(title.get("color")).toBe("var(--text-secondary)");
    expect(declarations(".vx-server-inventory > h2").get("font")).toBe("var(--type-section)");
  });

  it("lets a toolbar wrap with its actions kept on the trailing edge", () => {
    expect(declarations(".vx-multiplayer-toolbar").get("flex-wrap")).toBe("wrap");
    expect(declarations(".vx-multiplayer-toolbar > p").get("flex")).toBe("1 1 320px");
    expect(declarations(".vx-multiplayer-toolbar > .vx-action-row").get("margin-inline-start")).toBe("auto");
  });

  it("keeps the environment label beside its select instead of stacking the toolbar", () => {
    const label = declarations(".vx-multiplayer-toolbar > label");
    expect(label.get("white-space")).toBe("nowrap");
    expect(label.has("flex-wrap")).toBe(false);
    expect(declarations(".vx-multiplayer-toolbar > label > .vx-select").get("min-width")).toBe("var(--field-width-md)");
  });

  it("sets removing a bookmark apart at the bottom of the server detail", () => {
    expect(declarations(".vx-server-row").get("grid-template-rows")).toBe("auto minmax(0, 1fr) auto");
    expect(declarations(".vx-server-row__management").get("border-top")).toBe("var(--rule)");
    expect(declarations(".vx-server-row.vx-server-row--empty").get("grid-template-rows")).toBe("none");
  });

  it("never breaks a managed status word across lines", () => {
    const state = declarations(".vx-managed-state");
    expect(state.get("white-space")).toBe("nowrap");
    expect(state.get("flex")).toBe("none");
  });

  it("sizes the managed list like every rail and only fills an item on hover or selection", () => {
    expect(declarations(".vx-managed-layout").get("grid-template-columns")).toBe("var(--rail-w) minmax(0, 1fr)");
    expect(declarations(".vx-managed-list button").get("background")).toBe("transparent");
    expect(declarations(".vx-managed-list button:hover").get("background")).toBe("var(--fill-hover)");
    expect(declarations(".vx-managed-list button[aria-current='true']").get("background")).toBe("var(--fill-selected)");
  });

  it("draws status markers as pixels: filled, hollow or a diamond, never a dot", () => {
    expect(css).not.toMatch(/border-radius:\s*50%/);
    expect(declarations(".vx-managed-list__status i").get("border-radius")).toBe("0");
    expect(declarations(".vx-managed-list__status[data-state='running'] i").get("background")).toBe("var(--success)");
    expect(declarations(".vx-managed-list__status[data-state='stopped'] i").get("background")).toBe("transparent");
    expect(declarations(".vx-managed-list__status[data-state='error'] i").get("transform")).toContain("rotate(45deg)");
    expect(declarations(".vx-server-address-state[data-state='offline']").get("background")).toBe("transparent");
  });

  it("draws an unknown process state as the same grey diamond on both rails, never the running square", () => {
    for (const selector of [".vx-managed-list__status[data-state='unknown'] i", ".vx-managed-state[data-state='unknown'] i"]) {
      const marker = declarations(selector);
      expect(marker.get("transform"), selector).toBe(declarations(".vx-server-address-state[data-state='unknown']").get("transform"));
      expect(marker.get("transform"), selector).toContain("rotate(45deg)");
      expect(marker.has("background"), selector).toBe(false);
    }
    expect(declarations(".vx-managed-list__status i").get("background")).toBe("var(--text-tertiary)");
  });

  it("gives in-page banners a soft fill with a 3px semantic side bar", () => {
    for (const [selector, tone] of [[".vx-multiplayer-error", "danger"], [".vx-multiplayer-notice", "success"], [".vx-multiplayer-inline-notice", "warning"]]) {
      const banner = declarations(selector);
      expect(banner.get("border"), selector).toBe("1px solid var(--border-subtle)");
      expect(banner.get("border-inline-start"), selector).toBe(`3px solid var(--${tone}-border)`);
      expect(banner.get("background"), selector).toBe(`var(--${tone}-soft)`);
      expect(banner.has("border-color"), selector).toBe(false);
    }
  });

  it("drops the page banner margin for both banners inside the import dialog", () => {
    expect(declarations(".vx-import-dialog .vx-multiplayer-error").get("margin")).toBe("0");
    expect(declarations(".vx-import-dialog .vx-multiplayer-inline-notice").get("margin")).toBe("0");
  });

  it("turns the settings chevron with the fold", () => {
    expect(declarations(".vx-managed-section__chevron[data-open='true']").get("rotate")).toBe("180deg");
    expect(declarations(".vx-managed-section__toggle:hover").get("background")).toBe("var(--fill-hover)");
  });

  it("keeps the network empty state framed as one panel", () => {
    const empty = declarations(".vx-network-empty");
    expect(empty.get("border")).toBe("1px solid var(--border-subtle)");
    expect(empty.get("background")).toBe("var(--surface-panel)");
  });

  it("uses only current tokens: no ad-hoc mixes, raw type sizes or retired aliases", () => {
    expect(css).not.toMatch(/color-mix\(/);
    expect(css).not.toMatch(/(?:^|[;{\s])(?:font-size|line-height):/m);
    expect(css).not.toMatch(/var\(--(?:hairline|surface-hover|selection-fill|surface-solid|bg-base|bg-raised|text-(?:xs|sm|md|lg|xl))\)/);
    expect(declarations(".vx-server-population__cells > i[data-occupied='true']").get("background")).not.toContain("--accent");
  });
});
