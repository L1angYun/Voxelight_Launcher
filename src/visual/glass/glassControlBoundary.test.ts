// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from "node:fs";
import { parse, type AtRule, type Node, type Rule } from "postcss";
import { describe, expect, it } from "vitest";
import { contrast } from "../../design/accent";

// Owner requirement R2-10 (round 2): in the light theme the glass control's
// left boundary contrasts at least 2.5:1 with the background next to it.
// jsdom cannot composite the lens, so this guard resolves the declared
// boundary through the design tokens and composites it the way it paints.
const tokens = parse(readFileSync("src/design/tokens.css", "utf8"));
const glass = parse(readFileSync("src/visual/glass/glass.css", "utf8"));
const LIGHT_CONTROL = '[data-theme="light"] .vx-glass-surface[data-glass-variant="control"]';

function rules(sheet: ReturnType<typeof parse>, selector: string, inside?: (rule: Rule) => boolean) {
  const found: Record<string, string>[] = [];
  sheet.walkRules(rule => {
    if (!rule.selectors.map(value => value.trim()).includes(selector) || (inside && !inside(rule))) return;
    const values: Record<string, string> = {};
    rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
    found.push(values);
  });
  return found;
}
const inForcedColors = (rule: Rule) => {
  for (let node = rule.parent as Node | undefined; node; node = node.parent as Node | undefined)
    if (node.type === "atrule" && /forced-colors/.test((node as AtRule).params)) return true;
  return false;
};
// The light theme block in @layer tokens is the one that defines --border-strong.
const lightTheme = rules(tokens, '[data-theme="light"]').find(values => "--border-strong" in values)!;

function resolve(value: string, depth = 0): string {
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
  if (!reference) return value.trim();
  if (depth > 8 || !(reference[1] in lightTheme)) throw new Error(`Unresolved light token ${value}`);
  return resolve(lightTheme[reference[1]], depth + 1);
}
function rgba(value: string): [number, number, number, number] {
  const color = resolve(value);
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) return [0, 2, 4].map(at => parseInt(hex[1].slice(at, at + 2), 16)).concat(1) as [number, number, number, number];
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*(\d*\.?\d+)\s*)?\)$/.exec(color);
  if (!rgb) throw new Error(`Unsupported color ${color}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
}
const hex = (rgb: number[]) => `#${rgb.map(channel => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
function over(top: [number, number, number, number], bottom: number[]) {
  return hex(top.slice(0, 3).map((channel, index) => channel * top[3] + bottom[index] * (1 - top[3])));
}

describe("light glass control boundary", () => {
  const [control] = rules(glass, LIGHT_CONTROL);

  it("paints one boundary token on both the lens stroke and the inset edge", () => {
    expect(control["--vx-lens-boundary"]).toBe("var(--glass-control-boundary)");
    expect(control["box-shadow"]).toMatch(/^inset 0 0 0 1px var\(--glass-control-boundary\),/);
  });

  it("keeps the R2-10 owner floor of 2.5:1 against the light page", () => {
    const boundary = rgba(control["--vx-lens-boundary"]);
    // Worst case: the boundary over the lightest glass interior (its white
    // tint color), read against the page canvas and the panel surface.
    const interior = rgba("var(--glass-tint-color)");
    const edge = over(boundary, interior);
    for (const surface of ["--world-ink", "--surface-panel"]) {
      const page = hex(rgba(`var(${surface})`).slice(0, 3));
      expect(contrast(edge, page), `${edge} edge against ${surface} ${page}`).toBeGreaterThanOrEqual(2.5);
    }
  });

  it("leaves the dark boundary, high contrast and forced colors no weaker", () => {
    // The dark (default) lens boundary is untouched; only the light control overrides it.
    const setters: string[] = [];
    glass.walkDecls("--vx-lens-boundary", declaration => {
      setters.push(`${(declaration.parent as Rule).selector} => ${declaration.value}`);
    });
    expect(setters).toEqual([".vx-glass-surface => rgb(237 233 224 / .22)", `${LIGHT_CONTROL} => var(--glass-control-boundary)`]);
    // High contrast keeps the full --border-strong (--text-primary) edge it had,
    // and forced colors keep the system button border.
    expect(rules(tokens, '[data-high-contrast="true"]').some(values => values["--glass-control-boundary"] === "var(--border-strong)")).toBe(true);
    expect(rules(tokens, ":root", inForcedColors).some(values => values["--glass-control-boundary"] === "ButtonBorder")).toBe(true);
  });
});
