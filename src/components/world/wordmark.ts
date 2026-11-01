// SPDX-License-Identifier: GPL-3.0-only
import type { Camera } from "./camera";

const GLYPHS: Record<string, string> = {
  V: "10001 10001 10001 10001 10001 01010 00100", O: "01110 10001 10001 10001 10001 10001 01110",
  X: "10001 10001 01010 00100 01010 10001 10001", E: "11111 10000 10000 11110 10000 10000 11111",
  L: "10000 10000 10000 10000 10000 10000 11111", I: "01110 00100 00100 00100 00100 00100 01110",
  G: "01110 10001 10000 10111 10001 10001 01111", H: "10001 10001 10001 11111 10001 10001 10001",
  T: "11111 00100 00100 00100 00100 00100 00100",
};
const cells: Array<[number, number]> = [];
for (const [character, letter] of Array.from("VOXELIGHT").entries()) {
  GLYPHS[letter].split(" ").forEach((row, y) => {
    Array.from(row).forEach((pixel, x) => { if (pixel === "1") cells.push([character * 6 + x, y]); });
  });
}
export function buildWordTargets(camera: Camera, aspect: number, side: number, random = Math.random): Float32Array {
  const targets = new Float32Array(side * side * 4);
  const distance = 70;
  const cell = 2 * distance * camera.tanHalfFov * aspect * .62 / 53;
  let cursor = 0;
  for (let index = 0; index < side * side; index += 9) {
    const [column, row] = cells[cursor++ % cells.length];
    const x = (column - 26 + (random() - .5) * .62) * cell;
    const y = (3 - row + (random() - .5) * .62) * cell;
    for (let axis = 0; axis < 3; axis++) {
      targets[index * 4 + axis] = camera.eye[axis] + camera.forward[axis] * distance +
        camera.up[axis] * (distance * camera.tanHalfFov * .36 + y) + camera.right[axis] * x;
    }
    targets[index * 4 + 3] = 1;
  }
  return targets;
}
