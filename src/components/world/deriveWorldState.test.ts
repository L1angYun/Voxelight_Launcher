// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import type { Progress, RunningGame } from "../../lib/launcher";
import { defaults } from "../../lib/launcher";
import { deriveWorldState } from "./deriveWorldState";

const progress = (overrides: Partial<Progress> = {}): Progress => ({
  operation: "game.prepare", stage: "assets", completed: 0, total: 0,
  bytesCompleted: 0, bytesTotal: 0, message: "", versionId: "1.21.1", ...overrides,
});
const derive = (overrides: Partial<Progress> = {}) => deriveWorldState({
  busy: "game.prepare", progress: progress(overrides), running: [],
});

describe("world status from launcher state", () => {
  it("uses the same horizon and lattice defaults for new and upgraded installs", () => {
    expect(defaults).toMatchObject({ worldScene: "horizon", worldMaterial: "lattice" });
  });

  it("running wins over preparation without a selected instance", () => {
    const game: RunningGame = { pid: 41, versionId: "another-version", instanceId: "another-instance" };
    expect(deriveWorldState({ busy: "game.prepare", progress: progress({ completed: 1, total: 2 }), running: [game] }))
      .toEqual({ phase: "running", fraction: null });
    expect(deriveWorldState({ busy: "", progress: null, running: [], gamePid: 7 }))
      .toEqual({ phase: "running", fraction: null });
    expect(deriveWorldState({ busy: "game.prepare", progress: null, running: [game, { ...game, pid: 42 }] }).phase)
      .toBe("running");
  });

  it("only game.prepare counts as preparing and stale progress stays idle", () => {
    for (const busy of ["", "game.stop", "settings.save", "instance.install"]) {
      expect(deriveWorldState({ busy, progress: progress({ completed: 8, total: 10 }), running: [] }))
        .toEqual({ phase: "idle", fraction: null });
    }
  });

  it("prefers byte totals over item totals", () => {
    expect(derive({ bytesCompleted: 25, bytesTotal: 100, completed: 9, total: 10 }))
      .toEqual({ phase: "preparing", fraction: .25 });
    expect(derive({ bytesCompleted: 0, bytesTotal: 100, completed: 9, total: 10 }).fraction).toBe(0);
    expect(derive({ completed: 1, total: 4 }).fraction).toBe(.25);
  });

  it("reports unknown totals honestly rather than inventing progress", () => {
    expect(deriveWorldState({ busy: "game.prepare", progress: null, running: [] }))
      .toEqual({ phase: "preparing", fraction: null });
    expect(derive().fraction).toBeNull();
    for (const invalid of [NaN, Infinity, -Infinity, -1, 0]) {
      expect(derive({ bytesTotal: invalid, total: invalid }).fraction).toBeNull();
    }
  });

  it("clamps finite progress to the unit interval", () => {
    expect(derive({ completed: 5, total: 4 }).fraction).toBe(1);
    expect(derive({ bytesCompleted: 500, bytesTotal: 100 }).fraction).toBe(1);
    expect(derive({ bytesCompleted: -5, bytesTotal: 100 }).fraction).toBe(0);
    expect(derive({ completed: -2, total: 4 }).fraction).toBe(0);
  });

  it("rejects nonfinite counters and falls back to valid item progress", () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(derive({ bytesCompleted: invalid, bytesTotal: 100, completed: 1, total: 4 }).fraction).toBe(.25);
      expect(derive({ completed: invalid, total: 4 }).fraction).toBeNull();
    }
  });

  it("does not treat invalid process identifiers as a running game", () => {
    for (const gamePid of [0, -1, NaN, Infinity]) {
      expect(deriveWorldState({ busy: "", progress: null, running: [], gamePid }))
        .toEqual({ phase: "idle", fraction: null });
    }
  });

  it("stays pure so a new preparation does not inherit a previous fraction", () => {
    const input = Object.freeze({ busy: "game.prepare", progress: Object.freeze(progress({ completed: 8, total: 10 })), running: Object.freeze([]) });
    expect(deriveWorldState(input).fraction).toBe(.8);
    expect(deriveWorldState({ busy: "", progress: null, running: [] }).phase).toBe("idle");
    expect(derive({ completed: 1, total: 10 }).fraction).toBe(.1);
    expect(deriveWorldState(input).fraction).toBe(.8);
  });
});
