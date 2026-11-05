// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { groundHit, makeCamera, type Camera, type Vec3 } from "./camera";
import { WORLD_PRESETS } from "./presets";

function project(camera: Camera, point: Vec3): Vec3 {
  const m = camera.viewProj;
  const clip = Array.from({ length: 4 }, (_, row) => m[row] * point[0] + m[row + 4] * point[1] + m[row + 8] * point[2] + m[row + 12]);
  return [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]];
}
const dot = (left: Vec3, right: Vec3) => left[0] * right[0] + left[1] * right[1] + left[2] * right[2];

describe("world camera geometry", () => {
  it("projects the look-at point to the center for both scene cameras", () => {
    for (const { eye, at, fov } of Object.values(WORLD_PRESETS)) {
      const ndc = project(makeCamera(eye, at, fov, 16 / 9), at);
      expect(ndc[0]).toBeCloseTo(0, 5);
      expect(ndc[1]).toBeCloseTo(0, 5);
    }
  });

  // Feet coordinates recorded from the real a4f756e home layout, not derived
  // from camera math. The renderer anchors its island on the y=3 interaction
  // plane; this checks that footprint, not the varying rendered terrain tops.
  it.each([
    { width: 1280, height: 720, feetX: 808.5, feetY: 518.40625 },
    { width: 1050, height: 720, feetX: 677.5, feetY: 522.40625 },
    { width: 1920, height: 1080, feetX: 1128.5, feetY: 749.40625 },
  ])("keeps the $width×$height home feet inside the horizon island footprint with bottom clearance", ({ width, height, feetX, feetY }) => {
    const preset = WORLD_PRESETS.horizon;
    const camera = makeCamera(preset.eye, preset.at, preset.fov, width / height);
    const origin = groundHit(camera, width / height, feetX / width * 2 - 1, 1 - feetY / height * 2);
    expect(origin).not.toBeNull();
    const screen = (point: Vec3): [number, number] => {
      const ndc = project(camera, point);
      expect(ndc.every(Number.isFinite)).toBe(true);
      expect(ndc[2]).toBeGreaterThan(-1);
      expect(ndc[2]).toBeLessThan(1);
      return [(ndc[0] + 1) * width / 2, (1 - ndc[1]) * height / 2];
    };
    const center = screen([origin![0], 3, origin![1]]);
    expect(center[0]).toBeCloseTo(feetX, 3);
    expect(center[1]).toBeCloseTo(feetY, 3);

    const outline = Array.from({ length: 720 }, (_, index) => {
      const angle = index / 720 * Math.PI * 2;
      return screen([origin![0] + Math.cos(angle) * preset.island, 3, origin![1] + Math.sin(angle) * preset.island]);
    });
    // A point is inside this convex projected circle when it remains on the
    // same side of every edge. A bounding-box check alone would be weaker.
    const sides = outline.map((start, index) => {
      const end = outline[(index + 1) % outline.length];
      return (end[0] - start[0]) * (feetY - start[1]) - (end[1] - start[1]) * (feetX - start[0]);
    });
    expect(sides.every(side => side > 0) || sides.every(side => side < 0)).toBe(true);
    const left = Math.min(...outline.map(point => point[0]));
    const right = Math.max(...outline.map(point => point[0]));
    const bottom = Math.max(...outline.map(point => point[1]));
    expect(bottom).toBeLessThanOrEqual(height * .9);
    expect(Math.abs((left + right) / 2 - feetX)).toBeLessThan(40);
  });

  it("builds an orthonormal camera basis including vertical views", () => {
    for (const at of [[0, 0, 0], [0, 20, 0], [10, 3, -20]] as Vec3[]) {
      const camera = makeCamera([0, 10, 0], at, 36, 1.5);
      for (const basis of [camera.forward, camera.right, camera.up]) expect(Math.hypot(...basis)).toBeCloseTo(1, 8);
      expect(dot(camera.forward, camera.right)).toBeCloseTo(0, 8);
      expect(dot(camera.forward, camera.up)).toBeCloseTo(0, 8);
      expect(dot(camera.right, camera.up)).toBeCloseTo(0, 8);
      expect([...camera.viewProj].every(Number.isFinite)).toBe(true);
    }
  });

  it("intersects a downward center ray directly below the eye", () => {
    const camera = makeCamera([10, 20, 30], [10, 0, 30], 36, 16 / 9);
    expect(groundHit(camera, 16 / 9, 0, 0, 0)).toEqual([10, 30]);
  });

  it("intersects a tilted ray at its explicit ground height", () => {
    const camera = makeCamera([4, 12, 8], [4, 0, -4], 40, 2);
    const hit = groundHit(camera, 2, 0, 0, 0)!;
    expect(hit[0]).toBeCloseTo(4, 8);
    expect(hit[1]).toBeCloseTo(-4, 8);
    // The default ground is y=3, matching the concept's terrain interaction plane.
    expect(groundHit(camera, 2, 0, 0)![1]).toBeCloseTo(-1, 8);
  });

  it("rejects upward, horizontal, and behind-eye ground intersections", () => {
    expect(groundHit(makeCamera([0, 10, 0], [0, 20, -10], 36, 1), 1, 0, 0)).toBeNull();
    expect(groundHit(makeCamera([0, 10, 0], [0, 10, -10], 36, 1), 1, 0, 0)).toBeNull();
    expect(groundHit(makeCamera([0, -10, 0], [0, -20, -10], 36, 1), 1, 0, 0, 0)).toBeNull();
  });

  it("uses aspect and screen coordinates in pointer ray projection", () => {
    const camera = makeCamera([0, 10, 10], [0, 0, 0], 60, 2);
    const center = groundHit(camera, 2, 0, 0, 0)!;
    const right = groundHit(camera, 2, .5, 0, 0)!;
    const narrow = groundHit(camera, 1, .5, 0, 0)!;
    expect(center[0]).toBeCloseTo(0, 8);
    expect(right[0]).toBeGreaterThan(center[0]);
    expect(right[0]).toBeCloseTo(narrow[0] * 2, 8);
  });

  it("maps the near and far planes into WebGL clip depth", () => {
    const camera = makeCamera([0, 0, 0], [0, 0, -1], 60, 1);
    expect(project(camera, [0, 0, -.5])[2]).toBeCloseTo(-1, 5);
    expect(project(camera, [0, 0, -400])[2]).toBeCloseTo(1, 5);
  });

  it("returns independent finite camera values for degenerate framing", () => {
    const eye: Vec3 = [2, 3, 4];
    const camera = makeCamera(eye, eye, 0, 0);
    expect([...camera.viewProj, ...camera.forward, ...camera.right, ...camera.up]).not.toContain(NaN);
    expect([...camera.viewProj].every(Number.isFinite)).toBe(true);
    eye[0] = 999;
    expect(camera.eye).toEqual([2, 3, 4]);
  });
});
