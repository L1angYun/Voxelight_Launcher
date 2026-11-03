// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurvatureGeometry } from "./geometry";

describe("curvature image cache", () => {
  const shape: CurvatureGeometry = { width: 8, height: 6, radius: 2, bevel: 2, inset: 0, refraction: .9, dispersion: .65 };
  let encode: ReturnType<typeof vi.fn>;
  let getContext: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    let serial = 0;
    encode = vi.fn(() => `data:image/png;base64,${++serial}`);
    getContext = vi.fn(() => ({
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: vi.fn(),
    }));
    vi.stubGlobal("document", { createElement: vi.fn(() => ({ getContext, toDataURL: encode })) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reuses an image when a surface with identical geometry remounts", async () => {
    const { curvatureMapImage } = await import("./refractionImage");
    const first = curvatureMapImage(shape);
    expect(first).not.toBeNull();
    expect(curvatureMapImage({ ...shape })).toBe(first);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it("distinguishes every declared geometry and optical key", async () => {
    const { curvatureMapImage } = await import("./refractionImage");
    const images = new Set([curvatureMapImage(shape)]);
    for (const property of ["width", "height", "radius", "bevel", "inset", "refraction", "dispersion"] as const)
      images.add(curvatureMapImage({ ...shape, [property]: shape[property]! + 1 }));
    expect(images.size).toBe(8);
  });

  it("retains 32 images and promotes a hit before evicting the least recently used", async () => {
    const { curvatureMapImage } = await import("./refractionImage");
    const images = Array.from({ length: 32 }, (_, index) => curvatureMapImage({ ...shape, width: index + 8 }));
    expect(curvatureMapImage(shape)).toBe(images[0]);
    curvatureMapImage({ ...shape, width: 40 });
    expect(curvatureMapImage(shape)).toBe(images[0]);
    expect(curvatureMapImage({ ...shape, width: 9 })).not.toBe(images[1]);
    expect(encode).toHaveBeenCalledTimes(34);
  });

  it("does not retain an unavailable canvas or failed encoding", async () => {
    const { curvatureMapImage } = await import("./refractionImage");
    getContext.mockReturnValueOnce(null);
    expect(curvatureMapImage(shape)).toBeNull();
    encode.mockImplementationOnce(() => { throw new Error("encoding unavailable"); });
    expect(curvatureMapImage(shape)).toBeNull();
    expect(curvatureMapImage(shape)).not.toBeNull();
  });

  it("does not substitute a resting map for a live deformed lens", async () => {
    const { curvatureMapImage } = await import("./refractionImage");
    const resting = curvatureMapImage(shape);
    const bent = curvatureMapImage({ ...shape, optics: { bendX: 2, bendY: -1, pressure: .6, energy: .2, stretch: .12, heading: .2 } });
    expect(bent).not.toBe(resting);
    expect(bent).not.toBeNull();
  });

  it("reuses identical live poses and distinguishes every field that changes curvature", async () => {
    const { curvatureMapImage } = await import("./refractionImage");
    const optics = { bendX: 0, bendY: 0, pressure: 0, energy: 0, stretch: 0, heading: 0 };
    const resting = curvatureMapImage({ ...shape, optics });
    expect(curvatureMapImage({ ...shape, optics: { ...optics } })).toBe(resting);
    for (const property of ["bendX", "bendY", "pressure", "stretch", "heading"] as const)
      expect(curvatureMapImage({ ...shape, optics: { ...optics, [property]: .5 } })).not.toBe(resting);
    expect(encode).toHaveBeenCalledTimes(6);
  });
});
