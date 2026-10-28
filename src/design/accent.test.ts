import { describe, expect, it } from "vitest";
import { buildAccentScale, contrast } from "./accent";

describe("accent color roles", () => {
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
