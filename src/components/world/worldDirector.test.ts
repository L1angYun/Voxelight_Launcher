// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { createWorldDirector, FRONT_MAX, type WorldInputs } from "./worldDirector";

const initial: WorldInputs = { phase: "idle", fraction: null, page: "home", scene: "horizon", material: "lattice" };

function timeline(inputs: WorldInputs = initial) {
  const director = createWorldDirector(inputs);
  let now = 0;
  let frame = director.step(0, now);
  return {
    director,
    get frame() { return frame; },
    get now() { return now; },
    advance(seconds: number, fps = 60) {
      let remaining = seconds;
      while (remaining > 1e-9) {
        const dt = Math.min(1 / fps, remaining);
        now += dt * 1000;
        frame = director.step(dt, now);
        remaining -= dt;
      }
      return frame;
    },
    wake(dt: number, elapsedMs: number) {
      now += elapsedMs;
      frame = director.step(dt, now);
      return frame;
    },
  };
}

describe("crystal world director", () => {
  it("starts a preparation frontier outside the home island even at zero progress", () => {
    const time = timeline();
    time.director.setInputs({ ...initial, phase: "preparing", fraction: 0 });
    expect(time.director.step(0, time.now)).toMatchObject({ front: 30, cry: 30, ring: 30 });
    expect(time.advance(2).front).toBe(30);
  });

  it("dissolves the home island on content pages and lowers paper ink", () => {
    const time = timeline();
    time.director.setInputs({ ...initial, page: "content" });
    const early = time.advance(.1);
    expect(early.island).toBeLessThan(9);
    expect(early.island).toBeGreaterThan(-18);
    expect(time.director.snap()).toMatchObject({ island: -18, paperInk: .12 });
    time.director.setInputs(initial);
    expect(time.director.snap()).toMatchObject({ island: 9, paperInk: 1 });
  });

  it("flashes only on a successful home preparation and retires by 1400 ms", () => {
    const time = timeline();
    time.director.setInputs({ ...initial, phase: "preparing", fraction: .8 });
    time.advance(1);
    time.director.setInputs({ ...initial, phase: "running" });
    expect(time.director.step(0, time.now).flash).toBeCloseTo(1.1);
    expect(time.advance(.45).flash).toBeCloseTo(1.1 / Math.E);
    expect(time.advance(.949).flash).toBeGreaterThan(0);
    expect(time.advance(.001).flash).toBe(0);
  });

  it("never flashes initial running, direct idle-to-running, content launches or static policy", () => {
    expect(timeline({ ...initial, phase: "running" }).frame.flash).toBe(0);
    const idle = timeline(); idle.director.setInputs({ ...initial, phase: "running" });
    expect(idle.advance(.1).flash).toBe(0);
    const content = timeline({ ...initial, page: "content", phase: "preparing" });
    content.director.setInputs({ ...initial, page: "content", phase: "running" });
    expect(content.advance(.1).flash).toBe(0);
    const reduced = timeline({ ...initial, phase: "preparing" });
    reduced.director.setInputs({ ...initial, phase: "running" });
    expect(reduced.director.snap().flash).toBe(0);
    expect(reduced.advance(.1).flash).toBe(0);
  });
  it("starts the camera at zero speed and approaches with the 36/12 critical spring", () => {
    const time = timeline();
    const start = time.frame.eye[1];
    time.director.setInputs({ ...initial, page: "content" });
    const target = time.director.snap().eye[1];
    time.director.setInputs(initial); time.director.snap();
    time.director.setInputs({ ...initial, page: "content" });
    const first = time.advance(.001).eye[1];
    expect(Math.abs((first - start) / (target - start))).toBeLessThan(.0001);
    const halfway = time.advance(.499).eye[1];
    expect((halfway - start) / (target - start)).toBeGreaterThan(.8);
    expect((halfway - start) / (target - start)).toBeLessThan(.85);
    expect((time.advance(.5).eye[1] - start) / (target - start)).toBeGreaterThan(.97);
  });
  it("retreats on real elapsed time while a slow frame still caps simulation advancement", () => {
    const time = timeline({ ...initial, phase: "preparing", fraction: 1 }); time.advance(3);
    time.director.setInputs(initial);
    const before = time.director.step(0, time.now);
    const after = time.wake(.05, 2500);
    expect(after.cry).toBe(0); expect(after.front).toBe(0);
    expect(after.simTime - before.simTime).toBeLessThanOrEqual(.050001);
  });
  it("tracks real preparation progress even when GPU frames arrive slowly", () => {
    const time = timeline(); time.director.setInputs({ ...initial, phase: "preparing", fraction: .37 });
    time.director.step(0, time.now);
    for (let index = 0; index < 12; index++) time.wake(.05, 250);
    expect(time.frame.front).toBeCloseTo(79.95, 0);
    expect(time.frame.simTime).toBeCloseTo(.6, 5);
  });
  it("renders the selected scene and material correctly before the first animated frame", () => {
    expect(timeline().frame).toMatchObject({ eye: [-6, 14, 37], at: [2, 11, -40], fov: 36, profile: 0, mask: 0, lat: 1, island: 9, fogD: 150, bloom: .8, horizon: -1, exposure: 1 });
    expect(timeline({ ...initial, scene: "massif", material: "solid" }).frame)
      .toMatchObject({ eye: [-22, 33, 62], at: [-3, 8, -12], fov: 34, profile: 1, mask: 1, lat: 0, island: 0, fogD: 190, bloom: .7, horizon: -1, exposure: .95 });
    expect(timeline({ ...initial, material: "solid" }).frame).toMatchObject({ bloom: .6, horizon: .6, lat: 0 });
  });

  it("moves the crystal front from real progress without retreat within one preparation", () => {
    const time = timeline();
    time.director.setInputs({ ...initial, phase: "preparing", fraction: .5 });
    const half = time.advance(3).front;
    expect(half).toBeCloseTo(97.5, 0);
    time.director.setInputs({ ...initial, phase: "preparing", fraction: .2 });
    const next = time.advance(1);
    expect(next.front).toBeGreaterThanOrEqual(half);
    expect(next.front).toBeCloseTo(97.5, 0);
    expect(next.ring).toBe(next.front);
    expect(next.cry).toBeGreaterThanOrEqual(next.front);
  });

  it("creeps with unknown totals but never invents more than fifteen percent", () => {
    const time = timeline();
    time.director.setInputs({ ...initial, phase: "preparing", fraction: null });
    expect(time.advance(1).front).toBeGreaterThan(0);
    const frame = time.advance(119);
    expect(frame.front).toBeCloseTo(50.25, 0);
    expect(frame.front).toBeLessThanOrEqual(50.25 + 1e-6);
  });

  it("keeps confirmed progress when a later stage has an unknown total", () => {
    const time = timeline();
    time.director.setInputs({ ...initial, phase: "preparing", fraction: .8 });
    const known = time.advance(3).front;
    time.director.setInputs({ ...initial, phase: "preparing", fraction: null });
    expect(time.advance(2).front).toBeGreaterThanOrEqual(known);
  });

  it("fills the remaining front linearly within six hundred real milliseconds on running", () => {
    const time = timeline();
    time.director.setInputs({ ...initial, phase: "preparing", fraction: .1 });
    const from = time.advance(1).front;
    time.director.setInputs({ ...initial, phase: "running" });
    expect(time.advance(.3).front).toBeCloseTo((from + 165) / 2, 5);
    const full = time.advance(.3);
    expect(full.front).toBe(FRONT_MAX);
    expect(full.ring).toBe(0);
  });

  it("retreats after cancel or failure and restores the idle state", () => {
    for (const prepared of [.8, 1]) {
      const time = timeline();
      time.director.setInputs({ ...initial, phase: "preparing", fraction: prepared });
      time.advance(3);
      time.director.setInputs(initial);
      const retreat = time.advance(.2);
      expect(retreat.cry).toBeLessThan(prepared * 165);
      expect(retreat.ring).toBe(0);
      expect(time.advance(3)).toMatchObject({ cry: 0, front: 0, settled: false });
    }
  });

  it("clears previous progress even when a new launch begins before retreat finishes", () => {
    const time = timeline();
    time.director.setInputs({ ...initial, phase: "preparing", fraction: .8 });
    time.advance(3);
    time.director.setInputs(initial);
    time.director.setInputs({ ...initial, phase: "preparing", fraction: .05 });
    const restart = time.advance(2);
    expect(restart.front).toBeCloseTo(36.75, 0);
    expect(restart.cry).toBeLessThan(37);
  });

  it("dims and settles a running world and ignores later pointer activity", () => {
    const time = timeline({ ...initial, phase: "running" });
    const frame = time.advance(5);
    expect(frame).toMatchObject({ front: 165, settled: true, active: false, timeScale: .12 });
    expect(frame.exposure).toBeCloseTo(.3, 3);
    expect(frame.bloom).toBeCloseTo(.1, 3);
    expect(frame.runDim).toBeCloseTo(.3, 3);
    time.director.noteInteraction(time.now);
    expect(time.advance(.05)).toMatchObject({ settled: true, active: false });
    time.director.setInputs(initial);
    expect(time.advance(.05).settled).toBe(false);
    expect(time.advance(3).exposure).toBeCloseTo(1, 2);
  });

  it("dims content pages and uses the matching elevated camera", () => {
    const horizon = timeline({ ...initial, page: "content" }).frame;
    expect(horizon).toMatchObject({ eye: [-6, 34, 40], at: [0, 2, -46], exposure: .42, bloom: .4, horizon: -1, runDim: .5, dim: .55 });
    const massif = timeline({ ...initial, scene: "massif", page: "content", material: "solid" }).frame;
    expect(massif).toMatchObject({ eye: [-22, 46, 66], at: [-3, 6, -14], exposure: .42, bloom: .25, runDim: .5, lat: 0 });
  });

  it("interrupts composition changes smoothly and releases the same field for morphing", () => {
    const time = timeline();
    time.director.setInputs({ ...initial, scene: "massif", page: "content" });
    const begin = time.advance(1 / 60);
    expect(begin.eye[0]).toBeLessThan(-6);
    expect(begin.eye[0]).toBeGreaterThan(-22);
    expect(begin.morph).toMatchObject({ start: 0, dur: 1.2, toWord: false, fromWord: false, transit: 26 });
    expect(begin.active).toBe(true);
    expect(time.advance(2.1).active).toBe(false);
    expect(time.advance(3).eye[0]).toBeCloseTo(-22, 2);
    time.director.setInputs({ ...initial, material: "solid" });
    expect(time.advance(3).lat).toBeCloseTo(0, 2);
  });

  it("pushes the preparing camera toward its target with a smaller vertical push", () => {
    const time = timeline();
    time.director.setInputs({ ...initial, phase: "preparing", fraction: .1 });
    const pushed = time.advance(10);
    expect(pushed.eye[0]).toBeCloseTo(-5.28, 3);
    expect(pushed.eye[1]).toBeCloseTo(13.892, 3);
    expect(pushed.eye[2]).toBeCloseTo(30.07, 3);
  });

  it("switches to the high frame cap only during interaction and its one-second tail", () => {
    const time = timeline();
    expect(time.frame.active).toBe(false);
    time.director.noteInteraction(0);
    expect(time.advance(.5).active).toBe(true);
    expect(time.advance(.51).active).toBe(false);
  });

  it("uses real milliseconds for intro stages and completes by the 2.5-second deadline", () => {
    const time = timeline();
    time.director.beginIntro();
    expect(time.advance(.5)).toMatchObject({ introActive: true, active: true });
    expect(time.frame.morph).toMatchObject({ dur: .9, toWord: true, fromWord: false, transit: 10 });
    expect(time.advance(.6).morph.toWord).toBe(true);
    expect(time.advance(.3).morph).toMatchObject({ dur: 1.1, toWord: false, fromWord: true, transit: 16 });
    expect(time.advance(1.1).introActive).toBe(false);
  });

  it("publishes real phase time for readable intro motion independently of capped simulation", () => {
    const time = timeline(); time.director.beginIntro();
    expect(time.wake(.05, 900).introTime).toBeCloseTo(.9);
    const release = time.wake(.05, 500);
    expect(release.morph.fromWord).toBe(true);
    expect(release.introTime).toBeCloseTo(0);
    expect(time.wake(.05, 400).introTime).toBeCloseTo(.4);
    expect(time.frame.simTime).toBeCloseTo(.15);
    expect(time.wake(.05, 700)).toMatchObject({ introActive: false, introTime: 0 });
  });

  it("never stretches the intro deadline on low FPS or a sleep gap", () => {
    const time = timeline();
    time.director.beginIntro();
    expect(time.director.step(0, 0).introActive).toBe(true);
    const beforeSleep = time.director.step(.016, 16).simTime;
    const after = time.director.step(30, 30000);
    expect(after.simTime - beforeSleep).toBeLessThanOrEqual(.05 + 1e-9);
    expect(after.introActive).toBe(false);
    const slow = timeline();
    slow.director.beginIntro();
    expect(slow.advance(2.5, 6).introActive).toBe(false);
  });

  it("ends intro immediately on a press, launch, or leaving home", () => {
    for (const next of [null, { ...initial, phase: "preparing", fraction: 0 }, { ...initial, page: "content" }] as Array<WorldInputs | null>) {
      const time = timeline();
      time.director.beginIntro();
      time.advance(.2);
      if (next) time.director.setInputs(next);
      else time.director.endIntro();
      expect(time.advance(.01).introActive).toBe(false);
    }
  });

  it("does not restart an active intro when begin is called twice", () => {
    const time = timeline();
    time.director.beginIntro();
    time.advance(1);
    time.director.beginIntro();
    expect(time.advance(1.5).introActive).toBe(false);
  });

  it("ignores intro requests outside an idle home lattice scene", () => {
    for (const override of [{ page: "content" }, { phase: "preparing" }, { phase: "running" }, { material: "solid" }] as Array<Partial<WorldInputs>>) {
      const time = timeline({ ...initial, ...override });
      time.director.beginIntro();
      expect(time.advance(.1).introActive).toBe(false);
    }
  });

  it("caps simulation steps and prevents negative or nonfinite time from poisoning the frame", () => {
    const time = timeline();
    expect(time.wake(30, 30000).simTime).toBeLessThanOrEqual(.05);
    const before = time.frame.simTime;
    expect(time.wake(-1, 1).simTime).toBe(before);
    expect(time.wake(NaN, 1).simTime).toBe(before);
    expect(time.wake(1 / 60, 1).simTime).toBeGreaterThan(before);
  });
});
