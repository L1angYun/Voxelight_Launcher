import { readFileSync } from "node:fs";
import { parse } from "postcss";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/features/downloads/downloads.css", "utf8");
const sheet = parse(css);

describe("downloads stylesheet", () => {
  it("has no private rule colour, temporary mixes or the corner dot decoration", () => {
    expect(css).not.toMatch(/--download-rule|--download-raised/);
    expect(css).not.toMatch(/color-mix\(/);
    expect(css).not.toMatch(/radial-gradient\(/);
    const selectors: string[] = [];
    sheet.walkRules(rule => { selectors.push(...rule.selectors); });
    expect(selectors.some(selector => /\.vx-downloads-empty::after/.test(selector))).toBe(false);
  });

  it("gives a task row one elevation token instead of a three-layer shadow", () => {
    const shadows: string[] = [];
    sheet.walkDecls("box-shadow", declaration => { shadows.push(declaration.value); });
    for (const value of shadows) expect(value).toMatch(/^(?:var\(--[\w-]+\)|none)$/);
    const rowShadows: string[] = [];
    sheet.walkRules(rule => {
      if (rule.selectors.some(selector => /^\[data-theme="light"\] \.vx-task-row$/.test(selector)))
        rule.walkDecls("box-shadow", declaration => { rowShadows.push(declaration.value); });
    });
    expect(rowShadows).toEqual(["var(--shadow-1)"]);
  });

  it("gives the in-page error banner a soft fill with a 3px danger side bar", () => {
    const banner = new Map<string, string>();
    sheet.walkRules(rule => {
      if (rule.selectors.includes(".vx-downloads-error")) rule.walkDecls(declaration => { banner.set(declaration.prop, declaration.value); });
    });
    expect(banner.get("border")).toBe("1px solid var(--border-subtle)");
    expect(banner.get("border-inline-start")).toBe("3px solid var(--danger-border)");
    expect(banner.get("background")).toBe("var(--danger-soft)");
  });

  it("sets type only from tokens and keeps Doto for the large percentage", () => {
    expect(css).not.toMatch(/(?:^|[;{\s])(?:font-size|line-height|font-family):/m);
    expect(css).not.toMatch(/var\(--(?:hairline|surface-solid|bg-base|text-(?:xs|sm|md|lg|xl)|text-transfer-volume)\)/);
    let percent = "";
    sheet.walkRules(rule => {
      if (rule.selectors.includes(".vx-task-row__percent")) rule.walkDecls("font", declaration => { percent = declaration.value; });
    });
    expect(percent).toBe("var(--type-matrix)");
  });
});
