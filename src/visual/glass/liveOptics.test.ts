// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as live from "./liveOptics";

afterEach(() => vi.restoreAllMocks());

describe("live shared lens field", () => {
  it("updates sampled curvature and visible contour from one pose, then rests without allocations", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {},
    } as never);
    let serial = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => `data:image/png;base64,${++serial}`);
    const surface = document.createElement("div");
    surface.innerHTML = `<svg><feImage data-vx-curvature href="rest"/><feDisplacementMap data-vx-channel="0"/>
      <feDisplacementMap data-vx-channel="1"/><feDisplacementMap data-vx-channel="2"/>
      <path data-vx-contour/><linearGradient data-vx-reflection/></svg>`;
    const shape = { width: 96, height: 44, radius: 22, inset: 3 };
    live.syncSurfaceOptics(surface, shape);
    const restingClip = surface.style.clipPath;
    const restingImage = surface.querySelector("feImage")!.getAttribute("href");
    const restingScale = surface.querySelector('[data-vx-channel="1"]')!.getAttribute("scale");
    const pose = { bendX: 6, bendY: -2, pressure: 0.8, energy: 0.2, stretch: 0.15, heading: 0.2 };
    live.syncSurfaceOptics(surface, shape, pose);
    expect(surface.style.clipPath).not.toBe(restingClip);
    expect(surface.querySelector("feImage")!.getAttribute("href")).not.toBe(restingImage);
    expect(surface.querySelector('[data-vx-channel="1"]')!.getAttribute("scale")).not.toBe(restingScale);
    const epoch = surface.dataset.lensOpticsEpoch;
    live.syncSurfaceOptics(surface, shape, pose);
    expect(surface.dataset.lensOpticsEpoch).toBe(epoch);
    expect(serial).toBe(2);
    live.syncSurfaceOptics(surface, shape);
    expect(surface.style.clipPath).toBe(restingClip);
    live.resetSurfaceOptics(surface);
    expect(surface.style.clipPath).toBe("");
    live.syncSurfaceOptics(surface, shape);
    expect(surface.style.clipPath).toBe(restingClip);
  });
});
