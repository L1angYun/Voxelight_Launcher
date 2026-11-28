import { describe, expect, it } from "vitest";
import { buildAccentScale, contrast, DEFAULT_ACCENT } from "./accent";
import { ACCENT_PRESETS } from "./accentPresets";

const lightSurfaces = ["#f3f1eb", "#fcfaf6", "#ffffff"];
const darkSurfaces = ["#07080b", "#0e1013", "#131417", "#232528", "#2f3033"];

describe("accent color roles", () => {
  it.each([DEFAULT_ACCENT, "#ffffff", "#fff4a3", "#92ffff"])("keeps %s indicators readable against every light surface", (color) => {
    const scale = buildAccentScale(color, "light");
    expect(scale.indicator).toMatch(/^#[0-9a-f]{6}$/);
    // Revision 7 uses complete edge medians, rather than individual foreground pixels.
    for (const surface of [...lightSurfaces, "#dbd9d3"])
      expect(contrast(scale.indicator, surface)).toBeGreaterThanOrEqual(3);
    // Against black, contrast is strictly increasing with relative luminance.
    expect(contrast(scale.indicator, "#000000")).toBeGreaterThanOrEqual(contrast(scale.ink, "#000000"));
  });

  it("guards dark indicators against every dark reading surface", () => {
    for (const color of ["#000000", "#123456", "#0078d4", "#8b2671", "#ff0000"]) {
      const scale = buildAccentScale(color, "dark");
      expect(scale.indicator).toMatch(/^#[0-9a-f]{6}$/);
      for (const surface of darkSurfaces)
        expect(contrast(scale.indicator, surface), `${color} indicator on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("uses Windows' default blue when an accent cannot be parsed", () => {
    expect(DEFAULT_ACCENT).toBe("#0078d4");
    // The fallback input is Windows' blue; the published fill may be nudged a
    // step darker so white text keeps FILL_TEXT_MINIMUM after compositing.
    for (const theme of ["dark", "light"] as const) {
      const scale = buildAccentScale("not-a-color", theme);
      expect(scale.base).toBe(buildAccentScale(DEFAULT_ACCENT, theme).base);
      expect(contrast(scale.base, scale.foreground)).toBeGreaterThanOrEqual(4.6);
    }
  });

  it("keeps the exact chosen colour for presets that already carry their foreground", () => {
    for (const preset of ACCENT_PRESETS) {
      for (const theme of ["light", "dark"] as const)
        expect(buildAccentScale(preset.hex, theme).base, `${preset.id} ${theme}`).toBe(preset.hex);
    }
  });

  it("gives accent text its own readable ink without changing the chosen signal colour", () => {
    for (const theme of ["dark", "light"] as const) {
      const surfaces = theme === "light" ? lightSurfaces : darkSurfaces;
      for (const color of ["#000000", "#ffffff", DEFAULT_ACCENT, "#ff0000", "#0000ff", "#00ff80"]) {
        const scale = buildAccentScale(color, theme);
        expect(scale.ink).toMatch(/^#[0-9a-f]{6}$/);
        for (const surface of surfaces) expect(contrast(scale.ink, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("uses relative luminance for contrast", () => {
    expect(contrast("#000000", "#ffffff")).toBe(21);
    expect(contrast("#ffffff", "#ffffff")).toBe(1);
  });

  it("guards the primary fill and its hover against the chosen foreground", () => {
    // #767676-ish fills fail both #ffffff and #101418, so the fill itself must move.
    const colors = ["#000000", "#ffffff", "#ff7fb5", DEFAULT_ACCENT, "#123456", "#00ff80", "#777777", "#8a8a8a"];
    for (const theme of ["dark", "light"] as const) {
      for (const color of colors) {
        const scale = buildAccentScale(color, theme);
        expect(scale.foreground === "#ffffff" || scale.foreground === "#101418").toBe(true);
        for (const role of ["base", "hover", "active"] as const) {
          expect(contrast(scale[role], scale.foreground), `${color} ${role} (${theme})`).toBeGreaterThanOrEqual(4.6);
          expect(scale[role]).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  it("no longer hard-codes derived soft and border colours", () => {
    const scale = buildAccentScale(DEFAULT_ACCENT, "dark");
    expect(scale).not.toHaveProperty("soft");
    expect(scale).not.toHaveProperty("border");
    // tokens.css owns these now, derived from --accent and --accent-indicator.
    expect(Object.keys(scale).sort()).toEqual(["active", "base", "foreground", "hover", "indicator", "ink"]);
  });

  it("keeps every traditional Chinese preset readable in both themes", () => {
    expect(ACCENT_PRESETS).toHaveLength(11);
    for (const preset of ACCENT_PRESETS) {
      for (const theme of ["light", "dark"] as const) {
        const scale = buildAccentScale(preset.hex, theme);
        expect(scale.base).toBe(preset.hex);
        const surfaces = theme === "light" ? lightSurfaces : darkSurfaces;
        for (const surface of surfaces) {
          expect(contrast(scale.ink, surface), `${preset.id} ink on ${surface} (${theme})`).toBeGreaterThanOrEqual(4.5);
        }
        for (const role of ["base", "hover", "active"] as const)
          expect(contrast(scale[role], scale.foreground), `${preset.id} ${role} (${theme})`).toBeGreaterThanOrEqual(4.6);
        if (theme === "light") {
          for (const surface of [...surfaces, "#dbd9d3"]) {
            expect(contrast(scale.indicator, surface), `${preset.id} indicator on ${surface}`).toBeGreaterThanOrEqual(3);
          }
        } else {
          for (const surface of surfaces)
            expect(contrast(scale.indicator, surface), `${preset.id} indicator on ${surface}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });
});
