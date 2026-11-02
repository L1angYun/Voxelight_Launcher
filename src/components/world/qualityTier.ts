// SPDX-License-Identifier: GPL-3.0-only
import type { EffectsLevel } from "../../lib/launcher";

export interface Tier {
  kind: "animated" | "static" | "css";
  particleSide: 256 | 160 | 0;
  grid: 160 | 110;
  dprCap: 1.5 | 1;
  forceSolid: boolean;
}
export function selectTier(cap: { webgl2: boolean; floatTargets: boolean; effects: EffectsLevel; reducedMotion: boolean; highContrast: boolean }): Tier {
  if (!cap.webgl2) return { kind: "css", particleSide: 0, grid: 110, dprCap: 1, forceSolid: true };
  if (cap.effects === "lite" || cap.reducedMotion || cap.highContrast)
    return { kind: "static", particleSide: 0, grid: 110, dprCap: 1, forceSolid: true };
  return { kind: "animated", particleSide: cap.floatTargets ? 256 : 0, grid: 160, dprCap: 1.5, forceSolid: !cap.floatTargets };
}
export function nextTier(tier: Tier): Tier | null {
  if (tier.kind !== "animated") return null;
  if (tier.dprCap > 1) return { ...tier, dprCap: 1 };
  if (tier.grid > 110) return { ...tier, grid: 110, particleSide: tier.particleSide ? 160 : 0 };
  return null;
}

/** Workload cost and wall-clock sampling window are deliberately separate. */
export function createFrameBudget(budgetMs: number, windowMs = 2000) {
  let elapsed = 0, cost = 0, count = 0;
  return {
    sample(costMs: number, elapsedMs = costMs): "hold" | "downgrade" {
      if (!Number.isFinite(costMs) || costMs < 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return "hold";
      elapsed += elapsedMs; cost += costMs; count++;
      if (elapsed + 1e-6 < windowMs) return "hold";
      const overrun = cost / count > budgetMs;
      elapsed = 0; cost = 0; count = 0;
      return overrun ? "downgrade" : "hold";
    },
  };
}
