// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { Group, PerspectiveCamera, Vector3 } from "three";
import { PlayerObject } from "skinview3d";
import { headTargetAngles, MAX_HEAD_PITCH, MAX_HEAD_YAW, stepHeadAngles, stepHeadAnglesInto } from "./headTracking";

function projectedNoseOffset(rx: number, ry: number): { x: number; y: number } {
  const player = new PlayerObject();
  const wrapper = new Group();
  wrapper.add(player);
  wrapper.rotation.y = -0.28;
  player.skin.head.rotation.set(rx, ry, 0);
  wrapper.updateMatrixWorld(true);

  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 0, 60);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const center = new Vector3(0, 4, 0).applyMatrix4(player.skin.head.matrixWorld).project(camera);
  const nose = new Vector3(0, 4, 4).applyMatrix4(player.skin.head.matrixWorld).project(camera);
  return { x: nose.x - center.x, y: nose.y - center.y };
}

describe("character head tracking", () => {
  it("turns the head toward the pointer on both axes in projected camera space", () => {
    const rest = projectedNoseOffset(0, 0);

    const rightTarget = headTargetAngles({ x: 1, y: 0 });
    const leftTarget = headTargetAngles({ x: -1, y: 0 });
    const upTarget = headTargetAngles({ x: 0, y: -1 });
    const downTarget = headTargetAngles({ x: 0, y: 1 });

    expect(rightTarget).toEqual({ x: 0, y: MAX_HEAD_YAW });
    expect(leftTarget).toEqual({ x: 0, y: -MAX_HEAD_YAW });
    expect(upTarget).toEqual({ x: -MAX_HEAD_PITCH, y: 0 });
    expect(downTarget).toEqual({ x: MAX_HEAD_PITCH, y: 0 });

    // Screen NDC: +x is right, +y is up.
    expect(projectedNoseOffset(rightTarget.x, rightTarget.y).x).toBeGreaterThan(rest.x);
    expect(projectedNoseOffset(leftTarget.x, leftTarget.y).x).toBeLessThan(rest.x);
    expect(projectedNoseOffset(upTarget.x, upTarget.y).y).toBeGreaterThan(rest.y);
    expect(projectedNoseOffset(downTarget.x, downTarget.y).y).toBeLessThan(rest.y);
  });

  it("clamps out-of-range pointer coordinates and ignores non-finite values", () => {
    expect(headTargetAngles({ x: 5, y: 9 })).toEqual({ x: MAX_HEAD_PITCH, y: MAX_HEAD_YAW });
    expect(headTargetAngles({ x: -8, y: -4 })).toEqual({ x: -MAX_HEAD_PITCH, y: -MAX_HEAD_YAW });
    expect(headTargetAngles(null)).toEqual({ x: 0, y: 0 });
    expect(headTargetAngles({ x: Number.NaN, y: 0.5 })).toEqual({ x: 0, y: 0 });
    expect(headTargetAngles({ x: 0.5, y: Number.POSITIVE_INFINITY })).toEqual({ x: 0, y: 0 });
  });

  it("eases smoothly toward the pointer, eases back on leave, and never snaps when returning", () => {
    const rest = { x: 0, y: 0 };
    const pointer = { x: 1, y: 1 };

    // Entering does not snap to target on the first frame.
    const first = stepHeadAngles(rest, pointer, rest, 1 / 60);
    expect(first.x).toBeGreaterThan(0);
    expect(first.x).toBeLessThan(MAX_HEAD_PITCH * 0.4);
    expect(first.y).toBeGreaterThan(0);
    expect(first.y).toBeLessThan(MAX_HEAD_YAW * 0.4);

    let current = first;
    for (let i = 0; i < 90; i += 1) current = stepHeadAngles(current, pointer, rest, 1 / 60);
    expect(current.x).toBeCloseTo(MAX_HEAD_PITCH, 3);
    expect(current.y).toBeCloseTo(MAX_HEAD_YAW, 3);

    // Leaving eases back toward rest without snapping to zero.
    const leaving = stepHeadAngles(current, null, rest, 1 / 60);
    expect(leaving.x).toBeLessThan(current.x);
    expect(leaving.x).toBeGreaterThan(MAX_HEAD_PITCH * 0.5);
    expect(leaving.y).toBeLessThan(current.y);
    expect(leaving.y).toBeGreaterThan(MAX_HEAD_YAW * 0.5);

    // Returning mid-return smoothly reverses without snapping to the new target.
    let returning = leaving;
    for (let i = 0; i < 15; i += 1) returning = stepHeadAngles(returning, null, rest, 1 / 60);
    const midRest = returning;
    const opposite = { x: -1, y: -1 };
    const reentered = stepHeadAngles(midRest, opposite, rest, 1 / 60);
    expect(Math.abs(reentered.x - midRest.x)).toBeLessThan(0.15);
    expect(Math.abs(reentered.y - midRest.y)).toBeLessThan(0.2);
    expect(reentered.x).toBeLessThan(midRest.x);
    expect(reentered.y).toBeLessThan(midRest.y);

    // Leaving all the way settles cleanly at rest.
    let settled = reentered;
    for (let i = 0; i < 120; i += 1) settled = stepHeadAngles(settled, null, rest, 1 / 60);
    expect(settled).toEqual(rest);
  });

  it("caps large frame deltas so tab resumes never snap the head", () => {
    const rest = { x: 0, y: 0 };
    const afterStall = stepHeadAngles(rest, { x: 1, y: 1 }, rest, 10);
    expect(afterStall.x).toBeLessThan(MAX_HEAD_PITCH);
    expect(afterStall.y).toBeLessThan(MAX_HEAD_YAW);
    expect(stepHeadAngles(afterStall, { x: 1, y: 1 }, rest, 0)).toEqual(afterStall);
  });

  it("mutates head angles in place via stepHeadAnglesInto without allocating replacement objects", () => {
    const angles = { x: 0, y: 0 };
    const pointer = { x: 0.6, y: -0.4 };
    const expectedTrack = stepHeadAngles({ x: 0, y: 0 }, pointer, { x: 0, y: 0 }, 1 / 60);
    const sameTrack = stepHeadAnglesInto(angles, pointer, 0, 0, 1 / 60);
    expect(sameTrack).toBe(angles);
    expect(angles).toEqual(expectedTrack);

    const expectedZero = { ...angles };
    expect(stepHeadAnglesInto(angles, pointer, 0, 0, 0)).toBe(angles);
    expect(angles).toEqual(expectedZero);

    const expectedReturn = stepHeadAngles(angles, null, { x: 0.1, y: -0.05 }, 1 / 60);
    const sameReturn = stepHeadAnglesInto(angles, null, 0.1, -0.05, 1 / 60);
    expect(sameReturn).toBe(angles);
    expect(angles).toEqual(expectedReturn);
  });
});
