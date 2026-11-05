// SPDX-License-Identifier: GPL-3.0-only
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

type ReferenceSummary = { mean: number; sigma: number };

export type AppearanceBudget = {
  outsideApplies: boolean;
  outsideLimit: number | null;
  coverageLimit: number;
  sources: {
    d5e31ad: { complete: boolean; metrics: { coveragePercent: ReferenceSummary; outsideMeanAbsDelta?: ReferenceSummary } };
    "287a3af": { complete: boolean; metrics?: { outsideMeanAbsDelta: ReferenceSummary } };
    a4f756e: { complete: boolean; metrics: { islandMean: { mean: number } } };
  };
};

export function assertAppearanceBudget(entry: AppearanceBudget, key: string): AppearanceBudget {
  const finite = (value: unknown, label: string): number => {
    assert(typeof value === "number" && Number.isFinite(value), `${key}: ${label} must be finite`);
    return value;
  };
  const summary = (value: ReferenceSummary | undefined, label: string): ReferenceSummary => {
    const mean = finite(value?.mean, `${label}.mean`), sigma = finite(value?.sigma, `${label}.sigma`);
    assert(sigma >= 0, `${key}: ${label}.sigma must be non-negative`);
    return { mean, sigma };
  };
  assert(entry && typeof entry.outsideApplies === "boolean", `${key}: outsideApplies is required`);
  const reference = entry.sources?.d5e31ad, previous = entry.sources?.["287a3af"], light = entry.sources?.a4f756e;
  assert(reference?.complete === true && light?.complete === true, `${key}: historical references must be complete`);
  finite(light.metrics?.islandMean?.mean, "a4f756e.islandMean.mean");
  const coverage = summary(reference.metrics?.coveragePercent, "d5e31ad.coveragePercent");
  const coverageLimit = coverage.mean + 5 + 3 * coverage.sigma;
  assert.equal(entry.coverageLimit, coverageLimit, `${key}: coverageLimit differs from reference mean + 5 + 3 sigma`);
  if (entry.outsideApplies) {
    assert(previous?.complete === true, `${key}: outside reference 287a3af must be complete`);
    const before = summary(reference.metrics?.outsideMeanAbsDelta, "d5e31ad.outsideMeanAbsDelta");
    const excessive = summary(previous.metrics?.outsideMeanAbsDelta, "287a3af.outsideMeanAbsDelta");
    const outsideLimit = before.mean + .35 * (excessive.mean - before.mean);
    assert.equal(entry.outsideLimit, outsideLimit, `${key}: outsideLimit differs from the approved reference interpolation`);
  } else {
    assert.equal(entry.outsideLimit, null, `${key}: outsideLimit must be null when outside comparison does not apply`);
  }
  return entry;
}

export async function loadAppearanceBudget(theme: string, width: number): Promise<AppearanceBudget> {
  const data = JSON.parse(await readFile(new URL("../data/world-island-baseline.json", import.meta.url), "utf8"));
  const key = `${theme}-${width}`, entry = data.cases[key] as AppearanceBudget | undefined;
  if (!entry) throw new Error(`Missing appearance reference for ${key}`);
  return assertAppearanceBudget(entry, key);
}
