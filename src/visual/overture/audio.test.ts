// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { playOvertureTone } from "./audio";

describe("optional Overture audio", () => {
  it("does not construct an AudioContext when disabled", () => {
    const constructor = vi.fn();
    Object.defineProperty(window, "AudioContext", { configurable: true, value: constructor });
    expect(playOvertureTone("game-launched", false)).toBe(false);
    expect(constructor).not.toHaveBeenCalled();
  });
});
