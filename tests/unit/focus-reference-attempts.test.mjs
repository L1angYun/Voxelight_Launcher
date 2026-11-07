// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";

let referenceAttempts;
try {
  ({ referenceAttempts } = await import("../e2e/helpers/focus-reference-attempts.ts"));
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
function requireHelper() {
  assert.equal(typeof referenceAttempts, "function", "The reference-frame retry helper is missing");
}

test("a stable first pair is returned without another capture", async () => {
  requireHelper();
  const calls = [];
  const result = await referenceAttempts(async attempt => {
    calls.push(attempt);
    return { name: "first", edges: [{ replacedCount: 0, invalidReason: null, maxBackgroundDelta: 0 }] };
  });
  assert.deepEqual(calls, [0]);
  assert.equal(result.result.name, "first");
  assert.deepEqual(result.attempts.map(pair => pair.name), ["first"]);
});

test("a recorded delta of exactly eight never consumes the retry", async () => {
  requireHelper();
  const calls = [];
  const result = await referenceAttempts(async attempt => {
    calls.push(attempt);
    return { name: "boundary", edges: [{ replacedCount: 1, invalidReason: "background-frame-drift", maxBackgroundDelta: 8 }] };
  });
  assert.deepEqual(calls, [0]);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.result.name, "boundary");
});

test("an actual drift above eight captures one replacement pair and preserves both", async () => {
  requireHelper();
  const calls = [];
  const result = await referenceAttempts(async attempt => {
    calls.push(attempt);
    return attempt === 0
      ? { name: "drifted", edges: [{ replacedCount: 0, invalidReason: null, maxBackgroundDelta: 0 }, { replacedCount: 1, invalidReason: "background-frame-drift", maxBackgroundDelta: 9 }] }
      : { name: "replacement", edges: [{ replacedCount: 1, invalidReason: null, maxBackgroundDelta: 2 }] };
  });
  assert.deepEqual(calls, [0, 1]);
  assert.equal(result.result.name, "replacement");
  assert.deepEqual(result.attempts.map(pair => pair.name), ["drifted", "replacement"]);
});

test("a second drift stays invalid and does not trigger a third capture", async () => {
  requireHelper();
  const calls = [];
  const result = await referenceAttempts(async attempt => {
    calls.push(attempt);
    assert(calls.length <= 2, "Only one retry is permitted");
    return { name: attempt === 0 ? "first-drift" : "second-drift", edges: [{ replacedCount: 1, invalidReason: "background-frame-drift", maxBackgroundDelta: 20 }] };
  });
  assert.deepEqual(calls, [0, 1]);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.result.name, "second-drift");
  assert.equal(result.result.edges[0].invalidReason, "background-frame-drift");
});

for (const reason of ["offscreen-edge", "contrast-failed"]) {
  test(`${reason} does not retry even when a diagnostic delta exceeds eight`, async () => {
    requireHelper();
    const calls = [];
    const result = await referenceAttempts(async attempt => {
      calls.push(attempt);
      return { edges: [{ replacedCount: 1, invalidReason: reason, maxBackgroundDelta: 30 }] };
    });
    assert.deepEqual(calls, [0]);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.result.edges[0].invalidReason, reason);
  });
}

test("a drift label without an actual above-eight value does not retry", async () => {
  requireHelper();
  for (const delta of [undefined, null, Number.NaN]) {
    const calls = [];
    const result = await referenceAttempts(async attempt => {
      calls.push(attempt);
      return { edges: [{ replacedCount: 1, invalidReason: "background-frame-drift", maxBackgroundDelta: delta }] };
    });
    assert.deepEqual(calls, [0]);
    assert.equal(result.attempts.length, 1);
  }
});

test("a thrown first capture propagates without another attempt", async () => {
  requireHelper();
  const problem = new Error("frame stamp unavailable"), calls = [];
  await assert.rejects(referenceAttempts(async attempt => {
    calls.push(attempt);
    throw problem;
  }), error => error === problem);
  assert.deepEqual(calls, [0]);
});

test("a thrown replacement capture propagates instead of accepting the first invalid pair", async () => {
  requireHelper();
  const problem = new Error("replacement PNG unavailable"), calls = [];
  await assert.rejects(referenceAttempts(async attempt => {
    calls.push(attempt);
    if (attempt === 1) throw problem;
    return { edges: [{ replacedCount: 1, invalidReason: "background-frame-drift", maxBackgroundDelta: 9 }] };
  }), error => error === problem);
  assert.deepEqual(calls, [0, 1]);
});

for (const delta of [49, 255]) {
  test(`a zero-replacement station records delta ${delta} without retrying`, async () => {
    requireHelper();
    const calls = [];
    const result = await referenceAttempts(async attempt => {
      calls.push(attempt);
      return { name: "normal-only", edges: [
        { replacedCount: 0, invalidReason: "background-frame-drift", maxBackgroundDelta: delta },
        { replacedCount: 0, invalidReason: null, maxBackgroundDelta: 1 },
        { replacedCount: 0, invalidReason: null, maxBackgroundDelta: 0 },
        { replacedCount: 0, invalidReason: null, maxBackgroundDelta: 0 },
      ] };
    });
    assert.deepEqual(calls, [0]);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.result.name, "normal-only");
    assert.equal(result.result.edges[0].maxBackgroundDelta, delta);
  });
}

test("a replacement on one edge enables the retry for drift on a different edge", async () => {
  requireHelper();
  const calls = [];
  const result = await referenceAttempts(async attempt => {
    calls.push(attempt);
    return attempt === 0
      ? { name: "cross-edge-drift", edges: [
        { replacedCount: 3, invalidReason: null, maxBackgroundDelta: 0 },
        { replacedCount: 0, invalidReason: "background-frame-drift", maxBackgroundDelta: 49 },
        { replacedCount: 0, invalidReason: null, maxBackgroundDelta: 0 },
        { replacedCount: 0, invalidReason: null, maxBackgroundDelta: 0 },
      ] }
      : { name: "accepted-replacement", edges: [{ replacedCount: 0, invalidReason: null, maxBackgroundDelta: 255 }] };
  });
  assert.deepEqual(calls, [0, 1]);
  assert.deepEqual(result.attempts.map(pair => pair.name), ["cross-edge-drift", "accepted-replacement"]);
  assert.equal(result.result.edges[0].maxBackgroundDelta, 255);
});

for (const count of [undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
  test(`an invalid replacement count (${String(count)}) cannot silently mean an unused reference`, async () => {
    requireHelper();
    const calls = [];
    await assert.rejects(referenceAttempts(async attempt => {
      calls.push(attempt);
      return { edges: [{ replacedCount: count, invalidReason: "background-frame-drift", maxBackgroundDelta: 49 }] };
    }), /replacement count/i);
    assert.deepEqual(calls, [0]);
  });
}

test("an invalid replacement count in the second pair is rejected rather than accepted", async () => {
  requireHelper();
  const calls = [];
  await assert.rejects(referenceAttempts(async attempt => {
    calls.push(attempt);
    return attempt === 0
      ? { edges: [{ replacedCount: 1, invalidReason: "background-frame-drift", maxBackgroundDelta: 9 }] }
      : { edges: [{ invalidReason: null, maxBackgroundDelta: 0 }] };
  }), /replacement count/i);
  assert.deepEqual(calls, [0, 1]);
});
