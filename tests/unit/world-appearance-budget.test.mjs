// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { assertAppearanceBudget, loadAppearanceBudget } from "../e2e/helpers/world-appearance-budget.ts";

const fixture = () => ({
  outsideApplies: true, outsideLimit: 17, coverageLimit: 26.5,
  sources: {
    d5e31ad: { complete: true, metrics: { coveragePercent: { mean: 20, sigma: .5 }, outsideMeanAbsDelta: { mean: 10, sigma: .2 } } },
    "287a3af": { complete: true, metrics: { outsideMeanAbsDelta: { mean: 30, sigma: .3 } } },
    a4f756e: { complete: true, metrics: { islandMean: { mean: 157 } } },
  },
});

test("appearance budgets derive the outside interpolation and three-sigma coverage allowance", () => {
  const source = fixture();
  assert.equal(assertAppearanceBudget(source, "fixture"), source);
  const changedOutside = fixture(); changedOutside.outsideLimit = 18;
  assert.throws(() => assertAppearanceBudget(changedOutside, "fixture"), /outsideLimit/);
  const changedCoverage = fixture(); changedCoverage.coverageLimit = 25;
  assert.throws(() => assertAppearanceBudget(changedCoverage, "fixture"), /coverageLimit/);
});

test("appearance budget validation detects changed reference means and sigma", () => {
  for (const mutate of [
    value => { value.sources.d5e31ad.metrics.outsideMeanAbsDelta.mean += 1; },
    value => { value.sources["287a3af"].metrics.outsideMeanAbsDelta.mean += 1; },
    value => { value.sources.d5e31ad.metrics.coveragePercent.mean += 1; },
    value => { value.sources.d5e31ad.metrics.coveragePercent.sigma += .1; },
  ]) {
    const source = fixture(); mutate(source);
    assert.throws(() => assertAppearanceBudget(source, "fixture"), /Limit/);
  }
});

test("appearance budgets reject missing or invalid reference evidence", () => {
  for (const mutate of [
    value => { value.sources.d5e31ad.complete = false; },
    value => { value.sources["287a3af"].complete = false; },
    value => { value.sources.a4f756e.complete = false; },
    value => { value.sources.d5e31ad.metrics.coveragePercent.sigma = -1; },
    value => { value.sources.d5e31ad.metrics.outsideMeanAbsDelta.mean = Number.NaN; },
    value => { value.sources.a4f756e.metrics.islandMean.mean = Number.POSITIVE_INFINITY; },
  ]) {
    const source = fixture(); mutate(source);
    assert.throws(() => assertAppearanceBudget(source, "fixture"));
  }
});

test("coverage-only cases do not invent an unavailable outside reference", () => {
  const source = fixture();
  source.outsideApplies = false; source.outsideLimit = null;
  source.sources["287a3af"] = { complete: false };
  delete source.sources.d5e31ad.metrics.outsideMeanAbsDelta;
  assert.equal(assertAppearanceBudget(source, "fixture"), source);
  source.outsideLimit = 17;
  assert.throws(() => assertAppearanceBudget(source, "fixture"), /outsideLimit/);
});

test("versioned world baselines retain only budget inputs and no raw capture payload", async () => {
  const data = JSON.parse(await readFile(new URL("../e2e/data/world-island-baseline.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(data), ["cases"]);
  assert.deepEqual(Object.keys(data.cases).sort(), ["dark-1050", "dark-1280", "dark-1920", "light-1050", "light-1280"]);
  for (const [key, entry] of Object.entries(data.cases)) {
    assert.deepEqual(Object.keys(entry).sort(), ["coverageLimit", "outsideApplies", "outsideLimit", "sources"]);
    assert.deepEqual(Object.keys(entry.sources).sort(), ["287a3af", "a4f756e", "d5e31ad"]);
    for (const [ref, source] of Object.entries(entry.sources)) {
      assert.deepEqual(Object.keys(source).sort(), source.complete ? ["complete", "metrics"] : ["complete"]);
      if (!source.complete) continue;
      const expected = ref === "a4f756e" ? ["islandMean"] : ref === "287a3af" ? ["outsideMeanAbsDelta"]
        : entry.outsideApplies ? ["coveragePercent", "outsideMeanAbsDelta"] : ["coveragePercent"];
      assert.deepEqual(Object.keys(source.metrics).sort(), expected.sort(), `${key}/${ref}`);
      for (const [name, metric] of Object.entries(source.metrics)) {
        assert.deepEqual(Object.keys(metric).sort(), name === "islandMean" ? ["mean"] : ["mean", "sigma"]);
        for (const value of Object.values(metric)) assert.equal(Number.isFinite(value), true);
      }
    }
    const [theme, width] = key.split("-");
    assert.deepEqual(await loadAppearanceBudget(theme, Number(width)), entry);
  }
  await assert.rejects(loadAppearanceBudget("dark", 999), /Missing appearance reference/);
});
