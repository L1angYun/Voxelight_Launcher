import { describe, expect, it } from "vitest";
import { backdropPalette, mixHex, parseHex, ridgeProfile, withAlpha } from "./backdrop";

const luma = (hex: string) => {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe("backdrop colour helpers", () => {
  it("mixes hex colours channel by channel and clamps the amount", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#102030", "#ffffff", -1)).toBe("#102030");
    expect(mixHex("#102030", "#ffffff", 4)).toBe("#ffffff");
  });

  it("falls back to the default accent for anything that is not a six digit hex colour", () => {
    expect(parseHex("oklch(0.8 0.2 120)")).toEqual(parseHex("#b4f17a"));
    expect(parseHex("#12")).toEqual(parseHex("#b4f17a"));
    expect(parseHex(" #FF8000 ")).toEqual([255, 128, 0]);
  });

  it("writes an alpha colour and clamps the alpha", () => {
    expect(withAlpha("#ff8000", 0.5)).toBe("rgba(255, 128, 0, 0.500)");
    expect(withAlpha("#ff8000", 3)).toBe("rgba(255, 128, 0, 1.000)");
  });
});

describe("ridge profile", () => {
  it("is deterministic per seed and differs between seeds", () => {
    expect(ridgeProfile(7919, 40)).toEqual(ridgeProfile(7919, 40));
    expect(ridgeProfile(7919, 40)).not.toEqual(ridgeProfile(15838, 40));
  });

  it("stays inside the step range and climbs at most two steps per column", () => {
    for (const seed of [7919, 15838, 23757, 31676]) {
      const profile = ridgeProfile(seed, 58, 22);
      expect(profile).toHaveLength(58);
      profile.forEach((level, column) => {
        expect(Number.isInteger(level)).toBe(true);
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(22);
        if (column > 0) expect(Math.abs(level - profile[column - 1])).toBeLessThanOrEqual(2);
      });
    }
  });

  it("has real relief rather than a flat line", () => {
    for (const seed of [7919, 15838, 23757, 31676]) {
      const profile = ridgeProfile(seed, 40, 22);
      expect(Math.max(...profile) - Math.min(...profile)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("backdrop palette", () => {
  it("darkens the ridges towards the viewer in both themes", () => {
    for (const light of [true, false]) {
      for (const accent of ["#b4f17a", "#ff7fb5", "not a colour"]) {
        const { ridges } = backdropPalette(light, accent);
        expect(ridges).toHaveLength(4);
        for (let index = 1; index < ridges.length; index += 1) {
          expect(luma(ridges[index])).toBeLessThan(luma(ridges[index - 1]));
        }
      }
    }
  });

  it("lets the accent tint the horizon but not the top of the sky", () => {
    const green = backdropPalette(false, "#b4f17a");
    const pink = backdropPalette(false, "#ff7fb5");
    expect(green.skyHorizon).not.toBe(pink.skyHorizon);
    expect(green.skyTop).toBe(pink.skyTop);
  });
});
