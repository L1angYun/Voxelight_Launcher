// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as live from "./liveOptics";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("live shared lens field", () => {
  it("updates sampled curvature and visible contour from one pose, then rests without allocations", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {},
    } as never);
    let serial = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => `data:image/png;base64,${++serial}`);
    const callbacks: BlobCallback[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => { callbacks.push(callback); });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:live-curvature", revokeObjectURL: vi.fn() });
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
    // The old complete pose remains visible until the matching PNG is ready.
    expect(surface.style.clipPath).toBe(restingClip);
    expect(surface.querySelector("feImage")!.getAttribute("href")).toBe(restingImage);
    expect(callbacks).toHaveLength(1);
    callbacks[0](new Blob(["png"]));
    expect(surface.style.clipPath).not.toBe(restingClip);
    expect(surface.querySelector("feImage")!.getAttribute("href")).not.toBe(restingImage);
    expect(surface.querySelector('[data-vx-channel="1"]')!.getAttribute("scale")).not.toBe(restingScale);
    const epoch = surface.dataset.lensOpticsEpoch;
    live.syncSurfaceOptics(surface, shape, pose);
    expect(surface.dataset.lensOpticsEpoch).toBe(epoch);
    expect(serial).toBe(1);
    live.syncSurfaceOptics(surface, shape);
    expect(surface.style.clipPath).toBe(restingClip);
    live.resetSurfaceOptics(surface);
    expect(surface.style.clipPath).toBe("");
    live.syncSurfaceOptics(surface, shape);
    expect(surface.style.clipPath).toBe(restingClip);
  });

  it("cancels pending optical writes when a surface resets to fallback or unmounts", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {},
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,initial");
    const callbacks: BlobCallback[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => { callbacks.push(callback); });
    const createObjectURL = vi.fn(() => "blob:late");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const surface = document.createElement("div");
    surface.innerHTML = '<svg><feImage data-vx-curvature href="static"/></svg>';
    live.syncSurfaceOptics(surface, { width: 48, height: 44, radius: 20 },
      { bendX: 4, bendY: 1, pressure: .4, energy: .1 });
    const initialImage = surface.querySelector("feImage")!.getAttribute("href");
    expect(callbacks).toHaveLength(1);
    live.resetSurfaceOptics(surface);
    callbacks[0](new Blob(["png"]));
    expect(surface.style.clipPath).toBe("");
    expect(surface.querySelector("feImage")!.getAttribute("href")).toBe(initialImage);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("replaces a live resting Blob before releasing its URL on the static path", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {},
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,rest");
    const callbacks: BlobCallback[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => { callbacks.push(callback); });
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:resting", revokeObjectURL: revoke });
    const surface = document.createElement("div");
    surface.innerHTML = '<svg><feImage data-vx-curvature href="static"/></svg>';
    const shape = { width: 46, height: 44, radius: 20 };
    live.syncSurfaceOptics(surface, shape, { bendX: 4, bendY: 1, pressure: .4, energy: .1 });
    callbacks[0](new Blob(["png"]));
    live.syncSurfaceOptics(surface, shape, { bendX: 0, bendY: 0, pressure: 0, energy: 0 });
    callbacks[1](new Blob(["png"]));
    expect(surface.querySelector("feImage")!.getAttribute("href")).toBe("blob:resting");
    live.syncSurfaceOptics(surface, shape);
    expect(surface.querySelector("feImage")!.getAttribute("href")).toBe("data:image/png;base64,rest");
    expect(revoke).toHaveBeenCalledWith("blob:resting");
  });
});
