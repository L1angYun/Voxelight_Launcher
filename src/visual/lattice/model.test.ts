import { describe, expect, it } from "vitest";
import {
  latticeCells,
  latticeContourPoints,
  latticePercent,
  latticePointSet,
  latticeSignature,
  latticeSelection,
  resolveVisualOwner,
} from "./model";

describe("lattice data and visual ownership", () => {
  it("maps progress to a bounded, truthful cell count", () => {
    const cells = latticeCells({ completed: 37, total: 100 });
    expect(cells).toHaveLength(64);
    expect(cells.filter((cell) => cell.status === "done")).toHaveLength(23);
    expect(cells[0].start).toBe(0);
    expect(cells.at(-1)?.end).toBe(100);
    expect(latticeCells({ completed: 50, total: 200 }).filter((cell) => cell.status === "done")).toHaveLength(16);
    expect(latticeCells({ completed: 2, total: 4 })).toHaveLength(64);
    expect(latticeCells({ completed: 1, total: 4, status: "done" }).filter((cell) => cell.status === "done")).toHaveLength(16);
  });

  it("marks unknown totals and the first failed item without inventing completion", () => {
    expect(latticeCells({ completed: 0, total: 0 }).every((cell) => cell.status === "unknown")).toBe(true);
    const failed = latticeCells({ completed: 2, total: 4, status: "error" });
    expect(failed.find((cell) => cell.status === "error")?.index).toBe(32);
    expect(failed.filter((cell) => cell.status === "done")).toHaveLength(32);
  });

  it("builds a stable set of contour points without drawing a box", () => {
    const points = latticeContourPoints();
    expect(points).toHaveLength(64);
    expect(latticeContourPoints()).toEqual(points);
    const radius = 11;
    const onRoundedContour = (point: { x: number; y: number }) => {
      const nearestX = Math.min(Math.max(point.x, radius), 100 - radius);
      const nearestY = Math.min(Math.max(point.y, radius), 100 - radius);
      return Math.abs(Math.hypot(point.x - nearestX, point.y - nearestY) - radius) < 0.01;
    };
    expect(points.every(onRoundedContour)).toBe(true);
    expect(points.some((point) => point.x === 0 && point.y === 0)).toBe(false);
    expect(points.some((point) => point.x > 0 && point.x < 100 && point.y > 0 && point.y < 100)).toBe(true);
    expect(new Set(points.map((point) => `${point.x}:${point.y}`)).size).toBe(points.length);
    expect(points.filter((point) => point.anchor)).toHaveLength(4);
    expect(points.every((point) => point.radius >= 1.2 && point.radius <= 2.4)).toBe(true);
  });

  it("derives a stable point signature from the represented identity", () => {
    expect(latticeSignature("fixture-world")).toEqual(latticeSignature("fixture-world"));
    expect(latticeSignature("fixture-world")).not.toEqual(latticeSignature("another-world"));
    expect(latticeSignature("fixture-world")).toHaveLength(64);
    expect(latticeSignature("fixture-world").every((weight) => weight >= 0 && weight <= 1)).toBe(true);
  });

  it("moves the same point set from a loose field onto a tighter contour", () => {
    const loose = latticePointSet("none", "fixture-world");
    const hover = latticePointSet("hover", "fixture-world");
    const focus = latticePointSet("focus", "fixture-world");
    const selected = latticePointSet("selected", "fixture-world");
    expect(loose).toHaveLength(64);
    expect(loose.some((point, index) => point.x !== focus[index].x || point.y !== focus[index].y)).toBe(true);
    expect(Math.min(...hover.map((point) => Math.min(point.x, point.y)))).toBeGreaterThan(0);
    expect(Math.min(...focus.map((point) => Math.min(point.x, point.y)))).toBeLessThan(4);
    expect(Math.min(...selected.map((point) => Math.min(point.x, point.y)))).toBeLessThan(1);
    expect(selected.filter((point) => point.anchor)).toHaveLength(4);
  });

  it("reports percentages only when a positive total exists", () => {
    expect(latticePercent(0, 0)).toBeNull();
    expect(latticePercent(65, 130)).toBe(50);
    expect(latticePercent(300, 200)).toBe(100);
    expect(latticePercent(-5, 200)).toBe(0);
  });

  it("prioritizes selected, focus, hover, and the single Overture focal event", () => {
    expect(latticeSelection({ selected: true, focused: true, hovered: true }).shape).toBe("selected");
    expect(latticeSelection({ focused: true, hovered: true }).shape).toBe("focus");
    expect(latticeSelection({ hovered: true }).shape).toBe("hover");
    expect(resolveVisualOwner({ overturePlaying: true, cardHovered: true })).toBe("overture");
    expect(resolveVisualOwner({ cardHovered: true, lensPressed: true })).toBe("lens");
  });
});
