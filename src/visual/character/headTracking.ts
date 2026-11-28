// SPDX-License-Identifier: GPL-3.0-only

export const MAX_HEAD_PITCH = 0.35;
export const MAX_HEAD_YAW = 0.55;
export const HEAD_TRACK_RATE = 12;
export const HEAD_RETURN_RATE = 7;
const MAX_STEP_SECONDS = 0.1;
const SETTLE_EPSILON = 1e-4;

export interface HeadPointer {
  x: number;
  y: number;
}

export interface HeadAngles {
  x: number;
  y: number;
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function isUsablePointer(pointer: HeadPointer | null | undefined): pointer is HeadPointer {
  return Boolean(pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y));
}

/**
 * Convert normalized pointer coordinates (x: -1 left..+1 right, y: -1 top..+1 bottom)
 * into clamped skinview3d/Three.js head Euler angles looking toward the pointer.
 *
 * With the character facing +Z toward a +Z camera:
 * - positive rotation.x pitches the face downward (+pointer.y)
 * - positive rotation.y turns the face rightward (+pointer.x)
 */
export function headTargetAngles(pointer: HeadPointer | null | undefined): HeadAngles {
  if (!isUsablePointer(pointer)) return { x: 0, y: 0 };
  return {
    x: clampUnit(pointer.y) * MAX_HEAD_PITCH,
    y: clampUnit(pointer.x) * MAX_HEAD_YAW,
  };
}

/**
 * Smoothly advance the character head angles in place toward either the active
 * pointer target or the resting pose without allocating per-frame objects.
 */
export function stepHeadAnglesInto(
  current: HeadAngles,
  pointer: HeadPointer | null | undefined,
  restX: number,
  restY: number,
  dtSeconds: number,
): HeadAngles {
  const tracking = isUsablePointer(pointer);
  const goalX = tracking ? clampUnit(pointer.y) * MAX_HEAD_PITCH : restX;
  const goalY = tracking ? clampUnit(pointer.x) * MAX_HEAD_YAW : restY;
  const dt = Number.isFinite(dtSeconds) ? Math.max(0, Math.min(MAX_STEP_SECONDS, dtSeconds)) : 0;
  if (dt === 0) return current;
  const rate = tracking ? HEAD_TRACK_RATE : HEAD_RETURN_RATE;
  const alpha = 1 - Math.exp(-dt * rate);
  const nextX = current.x + (goalX - current.x) * alpha;
  const nextY = current.y + (goalY - current.y) * alpha;
  current.x = Math.abs(goalX - nextX) < SETTLE_EPSILON ? goalX : nextX;
  current.y = Math.abs(goalY - nextY) < SETTLE_EPSILON ? goalY : nextY;
  return current;
}

/**
 * Smoothly advance the character head angles toward either the active pointer
 * target or the resting pose so pointer enter, leave, return, and blur never snap.
 */
export function stepHeadAngles(
  current: HeadAngles,
  pointer: HeadPointer | null | undefined,
  rest: HeadAngles,
  dtSeconds: number,
): HeadAngles {
  return stepHeadAnglesInto({ x: current.x, y: current.y }, pointer, rest.x, rest.y, dtSeconds);
}
