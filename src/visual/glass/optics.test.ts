// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readGlassOptics } from "./optics";

function wrapped(styles: Record<string, string>): HTMLElement {
  const wrapper = document.createElement("div");
  const surface = document.createElement("div");
  wrapper.append(surface);
  for (const [name, value] of Object.entries(styles)) wrapper.style.setProperty(name, value);
  return surface;
}

describe("glass optics", () => {
  it("reports nothing for a surface whose control publishes no deformation", () => {
    expect(readGlassOptics(wrapped({}))).toBeUndefined();
  });

  it("reads the deformation a wrapping control publishes", () => {
    const surface = wrapped({
      "--jelly-bend-x": "3.5px",
      "--jelly-bend-y": "-2px",
      "--jelly-press": "0.8",
      "--jelly-energy": "0.2",
    });
    expect(readGlassOptics(surface)).toEqual({ bendX: 3.5, bendY: -2, pressure: 0.8, energy: 0.2 });
  });

  it("prefers the value nearest to the surface", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    const surface = document.createElement("div");
    outer.append(inner);
    inner.append(surface);
    outer.style.setProperty("--jelly-energy", "0.9");
    inner.style.setProperty("--jelly-energy", "0.1");
    expect(readGlassOptics(surface)?.energy).toBe(0.1);
  });

  it("clamps extreme values and treats malformed ones as rest", () => {
    const surface = wrapped({
      "--jelly-bend-x": "999px",
      "--jelly-bend-y": "abc",
      "--jelly-press": "5",
      "--jelly-energy": "-3",
    });
    expect(readGlassOptics(surface)).toEqual({ bendX: 24, bendY: 0, pressure: 1.16, energy: 0 });
  });

  it("does not look past the reach limit", () => {
    const top = document.createElement("div");
    top.style.setProperty("--jelly-energy", "0.5");
    let node = top;
    for (let i = 0; i < 6; i += 1) {
      const child = document.createElement("div");
      node.append(child);
      node = child;
    }
    expect(readGlassOptics(node)).toBeUndefined();
    expect(readGlassOptics(top)?.energy).toBe(0.5);
  });
});
