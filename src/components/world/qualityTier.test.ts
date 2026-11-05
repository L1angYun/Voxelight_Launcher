// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from "vitest";
import { createFrameBudget, nextTier, selectTier } from "./qualityTier";

const full = { webgl2: true, floatTargets: true, effects: "full" as const, reducedMotion: false, highContrast: false };
it("starts full capability at the approved counts, then reduces resolution before geometry", () => {
  const high = selectTier(full);
  expect(high).toEqual({ kind: "animated", particleSide: 256, grid: 160, dprCap: 1.5, forceSolid: false });
  const resolution = nextTier(high)!;
  expect(resolution).toEqual({ ...high, dprCap: 1 });
  const counts = nextTier(resolution)!;
  expect(counts).toEqual({ ...resolution, particleSide: 160, grid: 110 });
  expect(nextTier(counts)).toBeNull();
});
it("prefers static accessibility and supports CSS or solid capability fallback", () => {
  for (const change of [{ effects: "lite" as const }, { reducedMotion: true }, { highContrast: true }]) {
    const tier = selectTier({ ...full, ...change });
    expect(tier.kind).toBe("static");
    expect(tier.particleSide).toBe(0);
    expect(nextTier(tier)).toBeNull();
  }
  expect(selectTier({ ...full, webgl2: false }).kind).toBe("css");
  expect(selectTier({ ...full, floatTargets: false })).toMatchObject({ kind: "animated", forceSolid: true, particleSide: 0 });
});
it("waits for a sustained two-second workload window before a downgrade", () => {
  const budget = createFrameBudget(16.7);
  expect(budget.sample(40)).toBe("hold");
  const samples = Array.from({ length: 59 }, () => budget.sample(40));
  expect(samples).toContain("downgrade");
  const brief = createFrameBudget(16.7);
  brief.sample(40);
  expect(Array.from({ length: 230 }, () => brief.sample(10))).not.toContain("downgrade");
});
it("measures real elapsed windows separately from rendering cost and ignores invalid samples", () => {
  const budget = createFrameBudget(16.7);
  expect(budget.sample(Number.NaN, 100)).toBe("hold");
  expect(budget.sample(-1, 100)).toBe("hold");
  for (let i = 0; i < 59; i++) expect(budget.sample(20, 1000 / 30)).toBe("hold");
  expect(budget.sample(20, 1000 / 30)).toBe("downgrade");
  const cheap = createFrameBudget(16.7);
  for (let i = 0; i < 120; i++) expect(cheap.sample(2, 1000 / 30)).toBe("hold");
});

it("requires consecutive over-budget windows for submission fallback and resets after a healthy window", () => {
  const budget = createFrameBudget(16.7, 2000, 2);
  for (let window = 0; window < 4; window++) {
    const cost = window === 1 ? 10 : 30;
    for (let index = 0; index < 100; index++) {
      expect(budget.sample(cost, 20)).toBe(window === 3 && index === 99 ? "downgrade" : "hold");
    }
  }
});
