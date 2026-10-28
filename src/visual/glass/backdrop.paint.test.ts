// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { paintVoxelBackdrop } from "./backdrop";

function createCanvasContext() {
  const gradient = () => ({ addColorStop: vi.fn() });
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    createLinearGradient: vi.fn(gradient),
    createRadialGradient: vi.fn(gradient),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    translate: vi.fn(),
    fillStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    shadowBlur: 0,
    shadowColor: "",
  } as unknown as CanvasRenderingContext2D;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("paintVoxelBackdrop optical field", () => {
  it("paints a non-null static point field for glass refraction", () => {
    const context = createCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as never,
    );

    const canvas = paintVoxelBackdrop({
      light: false,
      accent: "#b4f17a",
      width: 320.4,
      height: 180.7,
    });

    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(canvas?.width).toBe(320);
    expect(canvas?.height).toBe(181);
    expect(context.fillRect).toHaveBeenCalled();
    expect(context.arc).toHaveBeenCalled();
    expect(context.lineTo).toHaveBeenCalled();
    expect(context.createLinearGradient).toHaveBeenCalled();
  });

  it("paints the same composition in light mode", () => {
    const context = createCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as never,
    );

    const canvas = paintVoxelBackdrop({
      light: true,
      accent: "#ff7fb5",
      width: 300,
      height: 180,
    });

    expect(canvas).not.toBeNull();
    expect(context.fillRect).toHaveBeenCalled();
    expect(context.lineTo).toHaveBeenCalled();
    expect(context.createRadialGradient).toHaveBeenCalled();
  });
});
