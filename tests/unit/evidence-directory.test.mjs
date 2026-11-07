// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

let sharedResolver;
try {
  ({ evidenceDirectory: sharedResolver } = await import("../e2e/helpers/evidence-directory.ts"));
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

const consumers = [
  ["card-theme.spec.ts", "card-theme"],
  ["global-glass.spec.ts", "global-glass"],
  ["reference-alignment.spec.ts", "reference-alignment"],
  ["round6-acceptance.spec.ts", "round6"],
  ["transitions.spec.ts", "transitions"],
  ["world-acceptance.spec.ts", "world-acceptance"],
];

// Execute the actual path-binding expression with controlled environment input.
// This catches a consumer going back to its own environment-name spelling,
// without importing Playwright's browser registrations into the Node runner.
function consumerDirectory(file, env) {
  const source = readFileSync(new URL("../e2e/" + file, import.meta.url), "utf8");
  const binding = source.match(/^const (?:evidence|EVIDENCE) = (.+);\r?$/m);
  assert(binding, file + " must expose its evidence directory binding");
  return new Function("resolve", "process", "evidenceDirectory", "return (" + binding[1] + ");")(
    resolve,
    { env },
    scope => {
      assert.equal(typeof sharedResolver, "function", "shared evidence directory resolver is missing");
      return sharedResolver(scope, env);
    },
  );
}

for (const [file, scope] of consumers) {
  test(file + " writes below the single configured evidence root", () => {
    assert.equal(consumerDirectory(file, { VOXELIGHT_E2E_EVIDENCE: "./fixture-evidence" }),
      resolve("fixture-evidence", scope));
  });
}

for (const name of [
  "VOXELIGHT_E2E_OUTPUT_DIR",
  "VOXELIGHT_TRANSITION_OUTPUT_DIR",
  "VOXELIGHT_WORLD_GATE_OUTPUT_DIR",
  "VOXELIGHT_TRANSITION_EVIDENCE",
  "VOXELIGHT_TASK8_EVIDENCE",
]) {
  test("a launcher using " + name + " fails instead of silently writing test-results", () => {
    for (const [file] of consumers) {
      assert.throws(() => consumerDirectory(file, { [name]: "./fixture-wrong-location" }), error => {
        assert.match(error.message, new RegExp(name));
        assert.match(error.message, /VOXELIGHT_E2E_EVIDENCE/);
        return true;
      }, file);
    }
  });
}

test("mixed canonical and obsolete configuration fails without printing environment values", () => {
  for (const [file] of consumers) {
    assert.throws(() => consumerDirectory(file, {
      VOXELIGHT_E2E_EVIDENCE: "./fixture-canonical-location",
      VOXELIGHT_TASK8_EVIDENCE: "./fixture-obsolete-location",
      VOXELIGHT_MS_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
    }), error => {
      assert.match(error.message, /VOXELIGHT_TASK8_EVIDENCE/);
      assert.match(error.message, /VOXELIGHT_E2E_EVIDENCE/);
      assert.doesNotMatch(error.message, /fixture-canonical-location|fixture-obsolete-location|11111111/);
      return true;
    }, file);
  }
});

test("bare Playwright runs keep all custom evidence below test-results", () => {
  for (const [file, scope] of consumers) assert.equal(consumerDirectory(file, {}), resolve("test-results", scope));
});

test("an empty configured root fails instead of choosing an implicit output location", () => {
  for (const [file] of consumers) assert.throws(
    () => consumerDirectory(file, { VOXELIGHT_E2E_EVIDENCE: " \t " }),
    /VOXELIGHT_E2E_EVIDENCE.*nonempty/,
    file,
  );
});

test("an invalid scope cannot escape or accidentally alias another evidence directory", () => {
  assert.equal(typeof sharedResolver, "function", "shared evidence directory resolver is missing");
  for (const scope of ["../outside", "/outside", "", "world-accepance"]) {
    assert.throws(() => sharedResolver(scope, { VOXELIGHT_E2E_EVIDENCE: "./fixture-evidence" }), /Unknown evidence scope/);
  }
});
