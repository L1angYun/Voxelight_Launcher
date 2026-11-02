// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from "vitest";
import { makeCamera } from "./camera";
import { buildWordTargets } from "./wordmark";

it("allocates one word target for every ninth particle in front of the camera", () => {
  const camera = makeCamera([0, 0, 10], [0, 0, 0], 90, 1);
  const targets = buildWordTargets(camera, 1, 256, () => .5);
  expect(targets).toHaveLength(262144);
  let count = 0;
  for (let index = 0; index < 65536; index++) {
    expect(targets[index * 4 + 3]).toBe(index % 9 === 0 ? 1 : 0);
    if (targets[index * 4 + 3]) {
      count++;
      expect(targets[index * 4 + 2]).toBeCloseTo(-60, 4);
    }
  }
  expect(count).toBe(7282);
  expect(targets[0]).toBeCloseTo(-26 * (140 * .62 / 53), 4);
  expect(targets[1]).toBeCloseTo(25.2 + 3 * (140 * .62 / 53), 4);
});

it("keeps seeded glyph placement deterministic at both particle budgets", () => {
  const camera = makeCamera([-6, 14, 37], [2, 18.5, -40], 36, 16 / 9);
  expect(buildWordTargets(camera, 16 / 9, 160, () => .3)).toEqual(buildWordTargets(camera, 16 / 9, 160, () => .3));
  expect(buildWordTargets(camera, 16 / 9, 160, () => .3)).not.toEqual(buildWordTargets(camera, 16 / 9, 160, () => .8));
});

it("can place the intro above the character without changing the default wordmark", () => {
  const camera = makeCamera([0, 0, 10], [0, 0, 0], 90, 1);
  const original = buildWordTargets(camera, 1, 160, () => .5);
  const elevated = buildWordTargets(camera, 1, 160, () => .5, [.28, .62]);
  expect(elevated[0] - original[0]).toBeCloseTo(19.6, 4);
  expect(elevated[1] - original[1]).toBeCloseTo(18.2, 4);
  expect(elevated[2]).toBeCloseTo(original[2]);
});
