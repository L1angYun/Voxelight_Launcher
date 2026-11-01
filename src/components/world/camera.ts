// SPDX-License-Identifier: GPL-3.0-only
export type Vec3 = [number, number, number];
export interface Camera {
  viewProj: Float32Array;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  tanHalfFov: number;
  eye: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(vector: Vec3, fallback: Vec3): Vec3 {
  const length = Math.hypot(...vector);
  return Number.isFinite(length) && length > 1e-9
    ? [vector[0] / length, vector[1] / length, vector[2] / length] : [...fallback];
}

export function makeCamera(eye: Vec3, at: Vec3, fovDeg: number, aspect: number): Camera {
  const forward = normalize([at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]], [0, 0, -1]);
  const worldUp: Vec3 = Math.abs(forward[1]) > .999 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(forward, worldUp), [1, 0, 0]);
  const up = cross(right, forward);
  const safeFov = Number.isFinite(fovDeg) && fovDeg > 0 ? Math.min(175, fovDeg) : 36;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const tanHalfFov = Math.tan(safeFov * Math.PI / 360);
  const near = .5, far = 400;
  const view = [right[0], up[0], -forward[0], 0, right[1], up[1], -forward[1], 0,
    right[2], up[2], -forward[2], 0, -dot(right, eye), -dot(up, eye), dot(forward, eye), 1];
  const projection = [1 / (tanHalfFov * safeAspect), 0, 0, 0, 0, 1 / tanHalfFov, 0, 0,
    0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0];
  const viewProj = new Float32Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    for (let index = 0; index < 4; index++) viewProj[column * 4 + row] += projection[index * 4 + row] * view[column * 4 + index];
  }
  return { viewProj, forward, right, up, tanHalfFov, eye: [...eye] };
}

export function groundHit(camera: Camera, aspect: number, ndcX: number, ndcY: number, groundY = 3): [number, number] | null {
  const width = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const ray: Vec3 = [0, 1, 2].map(index => camera.forward[index] +
    camera.right[index] * ndcX * camera.tanHalfFov * width + camera.up[index] * ndcY * camera.tanHalfFov) as Vec3;
  if (!Number.isFinite(ray[1]) || ray[1] >= -1e-6 || !Number.isFinite(groundY)) return null;
  const distance = (groundY - camera.eye[1]) / ray[1];
  return distance < 0 ? null : [camera.eye[0] + ray[0] * distance, camera.eye[2] + ray[2] * distance];
}
