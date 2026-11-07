import { describe, expect, it } from "vitest";
import { buildAccentScale, contrast } from "./accent";

describe("accent color roles", () => {
  it.each(["#b4f17a", "#ffffff", "#fff4a3", "#92ffff"])("makes %s indicators readable against every light surface", (color) => {
    const scale = buildAccentScale(color, "light");
    expect(scale.base).toBe(color);
    expect(scale.indicator).toMatch(/^#[0-9a-f]{6}$/);
    // Revision 7 uses complete edge medians, rather than individual foreground pixels.
    for (const surface of ["#f3f1eb", "#faf9f5", "#eae7e0", "#dbd9d3"])
      expect(contrast(scale.indicator, surface)).toBeGreaterThanOrEqual(3);
    // Against black, contrast is strictly increasing with relative luminance.
    expect(contrast(scale.indicator, "#000000")).toBeGreaterThanOrEqual(contrast(scale.ink, "#000000"));
  });

  it("uses the recalibrated light indicator for the default accent without changing ink", () => {
    const scale = buildAccentScale("#b4f17a", "light");
    expect(scale.indicator).toBe("#538900");
    expect(scale.ink).toBe("#3f7400");
  });

  it("preserves the exact chosen indicator color in dark mode", () => {
    for (const color of ["#b4f17a", "#ffffff", "#fff4a3", "#92ffff", "#123456"])
      expect(buildAccentScale(color, "dark").indicator).toBe(color);
  });

  it("gives accent text its own readable ink without changing the chosen signal color", () => {
    for (const theme of ["dark", "light"] as const) {
      const surfaces = theme === "light" ? ["#f3f1eb", "#faf9f5", "#eae7e0"] : ["#141516", "#242527", "#0d0f14"];
      for (const color of ["#000000", "#ffffff", "#b4f17a", "#ff0000", "#0000ff", "#00ff80"]) {
        const scale = buildAccentScale(color, theme);
        expect(scale.base).toBe(color);
        for (const surface of surfaces) expect(contrast(scale.ink, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("uses relative luminance for contrast", () => {
    expect(contrast("#000000", "#ffffff")).toBe(21);
    expect(contrast("#ffffff", "#ffffff")).toBe(1);
  });

  it("keeps foreground readable on dark, light, and saturated accents", () => {
    for (const theme of ["dark", "light"] as const) {
      for (const color of ["#000000", "#ffffff", "#ff7fb5", "#b4f17a", "#123456", "#00ff80"]) {
        const scale = buildAccentScale(color, theme);
        expect(scale.base).toMatch(/^#[0-9a-f]{6}$/);
        expect(contrast(scale.foreground, scale.base)).toBeGreaterThanOrEqual(4.5);
        expect(scale.soft).not.toBe(scale.base);
        expect(scale.border).not.toBe(scale.base);
      }
    }
  });

  it("falls back to the Voxelight accent for malformed input", () => {
    expect(buildAccentScale("not-a-color", "dark").base).toBe("#b4f17a");
  });
});
