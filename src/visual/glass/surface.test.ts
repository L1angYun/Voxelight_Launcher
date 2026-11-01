import { describe, expect, it } from "vitest";
import { sameSurface } from "./renderer";
import type { GlassSurfaceModel } from "./types";

const base: GlassSurfaceModel = {
  id: "surface",
  rect: { x: 0, y: 0, width: 100, height: 40 },
  radius: 20,
  variant: "control",
  active: true,
  opacity: 0.4,
};

describe("sameSurface", () => {
  it("treats an identical report as unchanged", () => {
    expect(sameSurface(base, { ...base, rect: { ...base.rect } })).toBe(true);
  });

  it("notices movement, resizing and clipping", () => {
    expect(sameSurface(base, { ...base, rect: { ...base.rect, x: 1 } })).toBe(false);
    expect(sameSurface(base, { ...base, rect: { ...base.rect, width: 101 } })).toBe(false);
    expect(sameSurface(base, { ...base, clip: { ...base.rect } })).toBe(false);
  });

  it("notices deformation published by a spring-driven control", () => {
    const bent = { ...base, optics: { bendX: 2, bendY: 0, pressure: 0, energy: 0 } };
    expect(sameSurface(base, bent)).toBe(false);
    expect(sameSurface(bent, { ...bent, optics: { ...bent.optics, energy: 0.3 } })).toBe(false);
  });

  it("treats missing optics and resting optics as the same", () => {
    expect(sameSurface(base, { ...base, optics: { bendX: 0, bendY: 0, pressure: 0, energy: 0 } })).toBe(true);
  });

  it("notices directional stretch even when position and pressure are unchanged", () => {
    expect(sameSurface(base, { ...base, optics: { bendX: 0, bendY: 0, pressure: 0, energy: 0, stretch: 0.1, heading: 0.4 } })).toBe(false);
  });
});
