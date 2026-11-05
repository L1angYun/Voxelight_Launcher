// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import * as capture from '../e2e/helpers/world-appearance-capture.ts';

function harness(values, captureCosts = []) {
  let clock = 0, index = 0;
  const observed = [], pauses = [];
  return {
    observed, pauses,
    options: {
      now: () => clock,
      delay: async milliseconds => { pauses.push(milliseconds); clock += milliseconds; },
      capture: async () => {
        const [coveragePercent, islandMean] = values[Math.min(index, values.length - 1)];
        const islandBeforeMs = clock;
        clock += captureCosts[index] ?? 0;
        const row = { at: islandBeforeMs, islandBeforeMs, islandAfterMs: clock, coveragePercent, islandMean };
        index++; observed.push(row); return row;
      },
    },
  };
}

test('appearance wait rejects stable coverage while the island is still brightening', async () => {
  const run = harness([[20, 76.4], [20.1, 82], [20.1, 85], [20.1, 88], [20.1, 90.5], [20.1, 91]]);
  const result = await capture.waitForAppearanceStability(run.options);
  assert.equal(result.status, 'stable');
  assert.equal(result.elapsedMs, 2000);
  assert.equal(result.samples.length, 6);
  assert.deepEqual(result.samples.map(sample => sample.islandMean), [76.4, 82, 85, 88, 90.5, 91]);
});

test('appearance wait uses the latest coverage pair instead of latching an earlier pass', async () => {
  const run = harness([[20, 50], [20.1, 54], [20.7, 54.2], [21.1, 54.3], [21.2, 54.4]]);
  const result = await capture.waitForAppearanceStability(run.options);
  assert.equal(result.status, 'stable');
  assert.equal(result.elapsedMs, 1600);
  assert.equal(result.samples.length, 5);
});

test('appearance wait spaces hidden capture windows by at least 400ms including capture cost', async () => {
  const run = harness([[20, 100], [20.1, 100.2]], [100, 100]);
  const result = await capture.waitForAppearanceStability(run.options);
  assert.equal(result.status, 'stable');
  assert.equal(result.elapsedMs, 600);
  assert.equal(result.samples[1].islandBeforeMs - result.samples[0].islandAfterMs, 400);
});

test('appearance stability thresholds are strict and do not accept a 399ms gap', () => {
  const first = { at: 0, islandBeforeMs: 0, islandAfterMs: 0, coveragePercent: 0, islandMean: 100 };
  const next = { at: 400, islandBeforeMs: 400, islandAfterMs: 400, coveragePercent: .2, islandMean: 100.5 };
  assert.equal(capture.appearanceSamplesStable(first, next), true);
  assert.equal(capture.appearanceSamplesStable(first, { ...next, islandBeforeMs: 399 }), false);
  assert.equal(capture.appearanceSamplesStable(first, { ...next, coveragePercent: .3 }), false);
  assert.equal(capture.appearanceSamplesStable(first, { ...next, islandMean: 101 }), false);
  assert.equal(capture.appearanceSamplesStable(first, { ...next, islandMean: null }), false);
});

test('appearance wait can settle after the former 8s limit within its shared 20s deadline', async () => {
  const run = harness([...Array.from({ length: 26 }, (_, index) => [20, index * 2]), [20, 50.5]]);
  const result = await capture.waitForAppearanceStability(run.options);
  assert.equal(result.status, 'stable');
  assert.equal(result.elapsedMs, 10400);
  assert.equal(result.samples.length, 27);
});

test('appearance wait stops at the shared 20s deadline when the island never settles', async () => {
  const values = Array.from({ length: 60 }, (_, index) => [20, index * 2]);
  const run = harness(values);
  const result = await capture.waitForAppearanceStability(run.options);
  assert.equal(result.status, 'timeout');
  assert.equal(result.elapsedMs, 20000);
  assert.equal(result.samples.length, 50);
  assert.equal(result.samples.at(-1).islandBeforeMs, 19600);
});

test('appearance wait rejects a stable observation that finishes after its deadline', async () => {
  const run = harness([[20, 100], [20, 100.1]], [0, 19700]);
  const result = await capture.waitForAppearanceStability(run.options);
  assert.equal(result.status, 'timeout');
  assert.equal(result.elapsedMs, 20100);
  assert.equal(result.samples.length, 2);
});

test('appearance wait also checks the deadline when confirming the final result', async () => {
  let clock = 0, count = 0, confirmations = 0;
  const result = await capture.waitForAppearanceStability({
    now: () => count === 2 ? (++confirmations === 1 ? 19999 : 20001) : clock,
    delay: async milliseconds => { clock += milliseconds; },
    capture: async () => {
      count++;
      return { at: clock, islandBeforeMs: clock, islandAfterMs: count === 2 ? 19999 : clock,
        coveragePercent: 20, islandMean: 100 };
    },
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.elapsedMs, 20001);
});

test('world frame rates use accepted-frame deltas and milliseconds without inventing reset samples', () => {
  assert.equal(capture.worldFrameRate({ atMs: 100, worldFrames: 20 }, { atMs: 1100, worldFrames: 260 }), 240);
  assert.equal(capture.worldFrameRate({ atMs: 0, worldFrames: 0 }, { atMs: 500, worldFrames: 30 }), 60);
  assert.equal(capture.worldFrameRate({ atMs: 100, worldFrames: 20 }, { atMs: 600, worldFrames: 20 }), 0);
  assert.equal(capture.worldFrameRate({ atMs: 100, worldFrames: 20 }, { atMs: 100, worldFrames: 30 }), null);
  assert.equal(capture.worldFrameRate({ atMs: 100, worldFrames: 20 }, { atMs: 600, worldFrames: 10 }), null);
  assert.equal(capture.worldFrameRate({ atMs: 100, worldFrames: NaN }, { atMs: 600, worldFrames: 30 }), null);
});

test('appearance wait records sampling errors and elapsed time for the failure artifact', async () => {
  let clock = 0;
  const result = await capture.waitForAppearanceStability({
    now: () => clock, delay: async milliseconds => { clock += milliseconds; },
    capture: async () => { clock = 125; throw new Error('Screenshot failed'); },
  });
  assert.equal(result.status, 'error');
  assert.equal(result.elapsedMs, 125);
  assert.match(result.error, /Screenshot failed/);
  assert.equal(result.samples.length, 0);
});
