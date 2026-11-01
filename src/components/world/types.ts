// SPDX-License-Identifier: GPL-3.0-only
export type WorldSceneId = "horizon" | "massif";
export type WorldMaterial = "lattice" | "solid";
export type WorldPhase = "idle" | "preparing" | "running";
export type WorldPage = "home" | "content";

export interface WorldStatus {
  phase: WorldPhase;
  /** Null means the launcher has not supplied a usable total. */
  fraction: number | null;
}
