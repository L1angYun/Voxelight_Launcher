// SPDX-License-Identifier: GPL-3.0-only
import type { EffectsLevel } from "../../lib/launcher";
import type { WorldMaterial, WorldSceneId } from "./types";
import type { WorldAvailability } from "./worldAvailability";

export const WORLD_INTRO_REPLAY_EVENT = "vx:world-intro-replay";

export interface WorldIntroReplayEligibility {
  effects: EffectsLevel;
  material: WorldMaterial;
  scene: WorldSceneId;
  reducedMotion?: boolean;
  highContrast?: boolean;
  sceneStatic?: boolean;
  availability?: WorldAvailability;
  /** The shell paused the scene, for example under a custom background image. */
  paused?: boolean;
}

/**
 * Only the animated Full lattice scene plays the standard assemble-wave intro.
 * Lite, static/reduced-motion/high-contrast tiers, solid material, fallback
 * renderers, or a scene paused under a custom background have no intro to replay.
 */
export function canReplayWorldIntro(options: WorldIntroReplayEligibility): boolean {
  if (options.effects !== "full") return false;
  if (options.paused) return false;
  if (options.reducedMotion || options.highContrast || options.sceneStatic) return false;
  if (options.material !== "lattice") return false;
  if (options.availability === "lite" || options.availability === "css" || options.availability === "solid-only") {
    return false;
  }
  return options.scene === "horizon" || options.scene === "massif";
}

export function requestWorldIntroReplay(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(WORLD_INTRO_REPLAY_EVENT));
}
