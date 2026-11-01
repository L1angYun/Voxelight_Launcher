// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { groundHit, makeCamera, type Camera, type Vec3 } from "./camera";

function project(camera: Camera, point: Vec3): Vec3 {
  const m = camera.viewProj;
  const clip = Array.from({ length: 4 }, (_, row) => m[row] * point[0] + m[row + 4] * point[1] + m[row + 8] * point[2] + m[row + 12]);
  return [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]];
}
const dot = (left: Vec3, right: Vec3) => left[0] * right[0] + left[1] * right[1] + left[2] * right[2];

describe("world camera geometry", () => {
  it("projects the look-at point to the center for both scene cameras", () => {
    const cameras: Array<[Vec3, Vec3, number]> = [
      [[-6, 14, 37], [2, 18.5, -40], 36],
      [[-22, 33, 62], [-3, 8, -12], 34],
    ];
    for (const [eye, at, fov] of cameras) {
      const ndc = project(makeCamera(eye, at, fov, 16 / 9), at);
      expect(ndc[0]).toBeCloseTo(0, 5);
      expect(ndc[1]).toBeCloseTo(0, 5);
    }
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
