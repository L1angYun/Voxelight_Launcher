// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AmbientPalette } from "../../design/ambientPresets";
import { ANCHORS, DRIFT_ORBIT_PERIODS_S, LIGHT_ANCHORS, PEAK_ALPHA, computeFieldStates } from "./ambientController";

const ambientDirectory = fileURLToPath(new URL(".", import.meta.url));
const ambientCss = readFileSync(join(ambientDirectory, "ambient.css"), "utf8");
const tokensCss = readFileSync(join(ambientDirectory, "../../design/tokens.css"), "utf8");

type Rule = { selector: string; conditional: boolean; declarations: [string, string][] };

/** Top-level and @layer rules in source order; @media/@supports rules are marked conditional. */
function readRules(css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const stack: { prelude: string; rule: Rule | null }[] = [];
  let buffer = "", depth = 0;
  for (const character of source) {
    if (character === "(") depth++;
    else if (character === ")") depth--;
    if (character === "{") {
      const prelude = buffer.trim();
      buffer = "";
      const conditional = stack.some((entry) => /^@(media|supports|container)/.test(entry.prelude));
      const rule = prelude.startsWith("@") ? null : { selector: prelude, conditional, declarations: [] as [string, string][] };
      if (rule) rules.push(rule);
      stack.push({ prelude, rule });
    } else if (character === "}" || (character === ";" && depth === 0)) {
      const text = buffer.trim();
      buffer = "";
      const owner = stack.at(-1)?.rule;
      const colon = text.indexOf(":");
      if (owner && colon > 0) owner.declarations.push([text.slice(0, colon).trim(), text.slice(colon + 1).trim().replace(/\s+/g, " ")]);
      if (character === "}") stack.pop();
    } else {
      buffer += character;
    }
  }
  return rules;
}

const tokenRules = readRules(tokensCss).filter((rule) => !rule.conditional);
const ambientRules = readRules(ambientCss);

/** The custom property as `theme` resolves it on <html>: later rules win, light overrides :root. */
function token(name: string, theme: "dark" | "light"): string {
  const scopes = theme === "dark" ? [":root"] : [":root", '[data-theme="light"]'];
  let value: string | undefined;
  for (const scope of scopes) {
    for (const rule of tokenRules) {
      if (rule.selector !== scope) continue;
      for (const [property, declared] of rule.declarations) if (property === name) value = declared;
    }
  }
  if (value === undefined) throw new Error(`${name} is not defined for ${theme}`);
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  return reference ? token(reference[1], theme) : value;
}

function declaration(selector: string, property: string): string | undefined {
  return ambientRules.filter((rule) => rule.selector === selector)
    .flatMap((rule) => rule.declarations).filter(([name]) => name === property).at(-1)?.[1];
}

function brightness(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`${hex} is not a #rrggbb color`);
  return (Number.parseInt(match[1], 16) + Number.parseInt(match[2], 16) + Number.parseInt(match[3], 16)) / 3;
}

/**
 * R2-06 calibration on the native GPU page (1440x930, default accent, Full
 * canvas, Library, Settings and Accounts): the page's own ambient controller
 * was stopped and drawn every 2 s across the 152 s drift orbit and at the six
 * brightest gutter phases an analytic search found over the fields' joint
 * drift period. With no veil the screen-blended dark light lifted the reading
 * probe's left gutter from --world-ink (8.67) to 54.33 at most (right gutter
 * 43.67; median 30.33). Under a veil the lift scales with 1 - veil.
 */
const CALIBRATED_OPACITY = 0.9;
const CALIBRATED_MAX_LIFT = 54.33 - 8.67;
const READING_PAGE = '.vx-app-body:not([data-current-page="home"]) > .vx-ambient::after';

describe("ambient light under reading pages", () => {
  it("veils the dark light below the window chrome on every page except Home, keeping the layer's own opacity", () => {
    const background = declaration(".vx-ambient::after", "background") ?? "";
    expect(background).toMatch(/^linear-gradient\(to bottom, transparent var\(--shell-height\b/);
    expect(background).toContain("rgb(0 0 0 / var(--ambient-reading-veil");
    expect(declaration(".vx-ambient::after", "opacity")).toBe("0");
    expect(declaration(READING_PAGE, "opacity")).toBe("1");
    // Spec 2.11.2: the layer keeps --ambient-opacity on every page; only the veil differs.
    const pageOpacityRules = ambientRules.filter((rule) => rule.selector.includes("data-current-page")
      && !rule.selector.includes("::after") && rule.declarations.some(([name]) => name === "opacity"));
    expect(pageOpacityRules).toEqual([]);
    expect(Number(token("--ambient-opacity", "dark"))).toBeCloseTo(CALIBRATED_OPACITY, 6);
  });

  it("keeps the dark page beside reading surfaces under the card and level with the panel at the brightest drift", () => {
    const veil = Number(token("--ambient-reading-veil", "dark"));
    const ink = brightness(token("--world-ink", "dark"));
    const panel = brightness(token("--surface-panel", "dark"));
    const card = brightness(token("--surface-card", "dark"));
    expect(veil).toBeGreaterThan(0);
    expect(veil).toBeLessThan(1);
    const brightestPage = ink + CALIBRATED_MAX_LIFT * (1 - veil);
    // The card (the character preview) stays at least 3 levels above the page.
    expect(card - brightestPage).toBeGreaterThanOrEqual(3);
    // The panel is not passed by more than one level, and only at that brightest phase.
    expect(brightestPage - panel).toBeLessThanOrEqual(1);
  });

  it("sets no veil in light themes, where multiply darkens the page under the surfaces", () => {
    expect(Number(token("--ambient-reading-veil", "light"))).toBe(0);
  });
});

/** The R3-4 silhouette ROIs (tests/e2e/helpers/world-appearance.ts): the sky strip lies above the far ROI's top. */
const RIDGE_SKY = { left: 0.703, right: 0.9375, bottom: 0.326 };
const LIGHT_PALETTE: AmbientPalette = ["#71cbee", "#a4a8e6", "#c9987e", "#cca4d3"];

describe("ambient light above the light horizon ridge", () => {
  it("matches the first-frame defaults to the --ambient-peak tokens in both themes", () => {
    for (const theme of ["dark", "light"] as const)
      PEAK_ALPHA[theme].forEach((peak, index) => expect(Number(token(`--ambient-peak-${index}`, theme)), `${theme} ${index}`).toBe(peak));
  });

  it("keeps every light field centre out of the sky above the ridge along its whole drift path", () => {
    for (const width of [1280, 1050]) {
      const height = 720, config = { enabled: true, theme: "light" as const, palette: LIGHT_PALETTE, intensity: 0.6 };
      const highest = [Infinity, Infinity, Infinity, Infinity];
      for (let timeMs = 0; timeMs <= Math.max(...DRIFT_ORBIT_PERIODS_S) * 1000; timeMs += 100) {
        for (const field of computeFieldStates(timeMs, width, height, config)) {
          const x = field.x / width, y = field.y / height;
          if (x >= RIDGE_SKY.left && x <= RIDGE_SKY.right)
            expect(y, `${width}: field ${field.index} at ${timeMs} ms`).toBeGreaterThan(RIDGE_SKY.bottom);
          highest[field.index] = Math.min(highest[field.index], y);
        }
      }
      // Field 1 orbits the ridge line: it never rises above 38% of the viewport.
      expect(highest[1], `${width}: field 1`).toBeGreaterThanOrEqual(0.38 - 1e-9);
    }
  });

  it("places the static field 1 where the canvas anchors it in each theme", () => {
    const percent = ([x, y]: readonly [number, number]) => `${Math.round(x * 100)}% ${Math.round(y * 100)}%`;
    expect(token("--ambient-anchor-1", "dark")).toBe(percent(ANCHORS[1]));
    expect(token("--ambient-anchor-1", "light")).toBe(percent(LIGHT_ANCHORS[1]));
    const statics = ambientRules.filter((rule) => rule.selector === ".vx-ambient__static")
      .flatMap((rule) => rule.declarations).filter(([name]) => name === "background").map(([, value]) => value);
    expect(statics.length).toBeGreaterThanOrEqual(2);
    for (const value of statics) expect(value).toContain("ellipse 62% 54% at var(--ambient-anchor-1, 78% 24%)");
  });

  it("keeps the light fields inside WP-01's 18-28% washes at the default intensity", () => {
    // WP-01: light fields read as soft but obvious washes, roughly 18-28% effective at their centres.
    const opacity = Number(token("--ambient-opacity", "light"));
    PEAK_ALPHA.light.forEach((_, index) => {
      const effective = Number(token(`--ambient-peak-${index}`, "light")) * 0.6 * opacity;
      expect(effective, `light field ${index}`).toBeGreaterThanOrEqual(0.18);
      expect(effective, `light field ${index}`).toBeLessThanOrEqual(0.28);
    });
  });
});
