// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurvatureGeometry } from "./geometry";
import * as images from "./refractionImage";

const shape: CurvatureGeometry = { width: 28, height: 20, radius: 8, bevel: 7, inset: 1,
  refraction: .9, dispersion: .65, optics: { bendX: 0, bendY: 0, pressure: 0, energy: 0, stretch: 0, heading: 0 } };
const pose = (bendX: number) => ({ ...shape, optics: { ...shape.optics!, bendX } });
let encodes: { done: BlobCallback; pixels: Uint8ClampedArray }[];
let alive: Set<string>;
let syncEncode: ReturnType<typeof vi.fn>;

beforeEach(() => {
  encodes = []; alive = new Set(); let serial = 0;
  syncEncode = vi.fn(() => { throw new Error("Live optics must not synchronously encode PNG"); });
  vi.stubGlobal("OffscreenCanvas", undefined);
  vi.stubGlobal("document", { createElement: () => {
    let pixels = new Uint8ClampedArray();
    return { getContext: () => ({
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: (image: { data: Uint8ClampedArray }) => { pixels = image.data.slice(); },
    }), toDataURL: syncEncode, toBlob: (done: BlobCallback) => encodes.push({ done, pixels }) };
  } });
  vi.stubGlobal("URL", {
    createObjectURL: () => { const url = `blob:curvature-${++serial}`; alive.add(url); return url; },
    revokeObjectURL: (url: string) => alive.delete(url),
  });
});
afterEach(() => vi.unstubAllGlobals());

function encoder(onImage = vi.fn()) {
  expect(images.createLiveCurvatureMaps).toBeTypeOf("function");
  return { queue: images.createLiveCurvatureMaps(onImage), onImage };
}
function finish(index: number, blob: Blob | null = new Blob(["png"], { type: "image/png" })) { encodes[index].done(blob); }

describe("live curvature encoding", () => {
  it("uses an offscreen bitmap when available so converting a live PNG needs no DOM canvas readback", async () => {
    let complete!: (blob: Blob) => void;
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() { return document.createElement("canvas").getContext("2d"); }
      convertToBlob() { return new Promise<Blob>(resolve => { complete = resolve; }); }
    });
    const { queue, onImage } = encoder();
    queue.update(pose(5));
    expect(encodes).toHaveLength(0);
    expect(complete).toBeTypeOf("function");
    complete(new Blob(["png"])); await Promise.resolve();
    expect(onImage).toHaveBeenCalledWith("blob:curvature-1", pose(5));
    queue.dispose();
  });

  it("falls back to the asynchronous DOM encoder when offscreen conversion rejects", async () => {
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() { return document.createElement("canvas").getContext("2d"); }
      convertToBlob() { return Promise.reject(new Error("Offscreen conversion unavailable")); }
    });
    const { queue, onImage } = encoder();
    queue.update(shape); expect(encodes).toHaveLength(0); await Promise.resolve();
    expect(encodes).toHaveLength(1); finish(0);
    expect(onImage).toHaveBeenCalledWith("blob:curvature-1", shape);
    queue.dispose();
  });
  it("publishes a real deformed field asynchronously without calling the synchronous encoder", () => {
    const { queue, onImage } = encoder();
    queue.update(pose(5));
    expect(onImage).not.toHaveBeenCalled();
    expect(encodes).toHaveLength(1);
    finish(0);
    expect(onImage).toHaveBeenCalledWith("blob:curvature-1", pose(5));
    expect(syncEncode).not.toHaveBeenCalled();
    queue.dispose(); expect(alive.size).toBe(0);
  });

  it("keeps one encode in flight and only the latest waiting pose, without publishing a stale result", () => {
    const { queue, onImage } = encoder();
    queue.update(pose(1)); queue.update(pose(2)); queue.update(pose(3));
    expect(encodes).toHaveLength(1);
    finish(0);
    expect(onImage).not.toHaveBeenCalled();
    expect(encodes).toHaveLength(2);
    finish(1);
    expect(onImage).toHaveBeenCalledTimes(1);
    expect(onImage).toHaveBeenLastCalledWith("blob:curvature-2", pose(3));
    queue.dispose();
  });

  it("reuses a completed pose immediately and never overwrites it with an older completion", () => {
    const { queue, onImage } = encoder();
    queue.update(pose(1)); finish(0);
    queue.update(pose(2)); queue.update(pose(1)); finish(1);
    expect(onImage).toHaveBeenCalledTimes(1);
    expect(encodes).toHaveLength(2);
    queue.update(pose(2));
    expect(onImage).toHaveBeenLastCalledWith("blob:curvature-2", pose(2));
    expect(encodes).toHaveLength(2);
    queue.dispose();
  });

  it("keeps every curvature-changing pose channel in the cache and encoded field", () => {
    const { queue } = encoder();
    const baseline = { ...shape, optics: { ...shape.optics!, stretch: .15 } };
    queue.update(baseline); finish(0);
    for (const [index, channel] of (["bendX", "bendY", "pressure", "stretch", "heading"] as const).entries()) {
      const optics = { ...baseline.optics, [channel]: channel === "pressure" ? .6 : 1 };
      queue.update({ ...shape, optics }); finish(index + 1);
      expect(encodes[index + 1].pixels).not.toEqual(encodes[0].pixels);
    }
    expect(encodes).toHaveLength(6);
    queue.dispose();
  });

  it("bounds live URLs, promotes cache hits, and frees every image on disposal", () => {
    const { queue, onImage } = encoder();
    for (let index = 0; index < 32; index++) { queue.update({ ...shape, width: 28 + index }); finish(index); }
    queue.update(shape);
    expect(onImage).toHaveBeenLastCalledWith("blob:curvature-1", shape);
    queue.update({ ...shape, width: 60 }); finish(32);
    expect(alive.size).toBe(32);
    expect(alive.has("blob:curvature-1")).toBe(true);
    expect(alive.has("blob:curvature-2")).toBe(false);
    queue.dispose(); expect(alive.size).toBe(0);
  });

  it("discards a completion after disposal without creating a URL or touching its consumer", () => {
    const { queue, onImage } = encoder();
    queue.update(shape); queue.dispose(); finish(0);
    expect(onImage).not.toHaveBeenCalled(); expect(alive.size).toBe(0);
    queue.update(shape); expect(encodes).toHaveLength(1);
  });

  it("retains the previous image on failed encoding and permits retry", () => {
    const { queue, onImage } = encoder();
    queue.update(shape); finish(0);
    queue.update(pose(3)); finish(1, null);
    expect(onImage).toHaveBeenCalledTimes(1);
    queue.update(pose(3)); finish(2);
    expect(onImage).toHaveBeenLastCalledWith("blob:curvature-2", pose(3));
    queue.dispose();
  });

  it("retains the static image when async encoding is unavailable", () => {
    const { queue, onImage } = encoder();
    vi.stubGlobal("document", { createElement: () => ({ toDataURL: syncEncode }) });
    expect(() => queue.update(shape)).not.toThrow();
    expect(onImage).not.toHaveBeenCalled(); expect(syncEncode).not.toHaveBeenCalled();
    queue.dispose();
  });

  it("retains the visible image if DOM encoding throws and accepts the next valid request", () => {
    const { queue, onImage } = encoder();
    queue.update(shape); finish(0);
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementationOnce(() => {
      const canvas = create("canvas");
      canvas.toBlob = () => { throw new Error("Encoder unavailable"); };
      return canvas;
    });
    queue.update(pose(2));
    expect(onImage).toHaveBeenCalledTimes(1);
    queue.update(pose(2)); finish(1);
    expect(onImage).toHaveBeenLastCalledWith("blob:curvature-2", pose(2));
    queue.dispose();
  });
});
