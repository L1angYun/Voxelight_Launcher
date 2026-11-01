// SPDX-License-Identifier: GPL-3.0-only
import type { Vec3 } from "./camera";
import type { WorldMaterial, WorldSceneId } from "./types";

interface ScenePreset {
  eye: Vec3; at: Vec3; fov: number; profile: number; mask: number; exposure: number; fogD: number;
  bloom: Record<WorldMaterial, number>; horizon: Record<WorldMaterial, number>; island: number;
}
interface ContentPreset {
  eye: Vec3; at: Vec3; exposure: number; bloom: Record<WorldMaterial, number>; horizon: number;
}

export const WORLD_PRESETS: Record<WorldSceneId, ScenePreset> = {
  horizon: { eye: [-6, 14, 37], at: [2, 18.5, -40], fov: 36, profile: 0, mask: 0,
    exposure: 1, fogD: 150, bloom: { solid: .6, lattice: .8 }, horizon: { solid: .6, lattice: -1 }, island: 9 },
  massif: { eye: [-22, 33, 62], at: [-3, 8, -12], fov: 34, profile: 1, mask: 1,
    exposure: .95, fogD: 190, bloom: { solid: .7, lattice: .8 }, horizon: { solid: -1, lattice: -1 }, island: 5 },
};
export const LIST_CAM: Record<WorldSceneId, ContentPreset> = {
  horizon: { eye: [-6, 34, 40], at: [0, 2, -46], exposure: .42, bloom: { solid: .25, lattice: .4 }, horizon: -1 },
  massif: { eye: [-22, 46, 66], at: [-3, 6, -14], exposure: .42, bloom: { solid: .25, lattice: .4 }, horizon: -1 },
};
