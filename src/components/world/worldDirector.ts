// SPDX-License-Identifier: GPL-3.0-only
import type { Vec3 } from "./camera";
import { LIST_CAM, WORLD_PRESETS } from "./presets";
import type { WorldMaterial, WorldPage, WorldPhase, WorldSceneId } from "./types";
import { createSpring, advanceSpring, snapSpring } from "../../visual/glass/jelly";
import { MOTION } from "../../design/motion";

export const FRONT_MAX = 165;
const FRONT_START = MOTION.world.frontStart;
const progressRadius = (fraction: number) => FRONT_START + Math.max(0, Math.min(1, fraction)) * (FRONT_MAX - FRONT_START);
export interface WorldInputs {
  phase: WorldPhase; fraction: number | null; page: WorldPage; scene: WorldSceneId; material: WorldMaterial;
}
export interface WorldFrame {
  page: WorldPage; flash: number; paperInk: number;
  eye: Vec3; at: Vec3; fov: number; profile: number; mask: number; lat: number; island: number;
  exposure: number; fogD: number; bloom: number; horizon: number; runDim: number; dim: number;
  front: number; cry: number; charge: number; timeScale: number; simTime: number; ring: number;
  morph: { start: number; dur: number; toWord: boolean; fromWord: boolean; transit: number };
  /** Real seconds since the current intro gather/return stage began. */
  introTime: number; introActive: boolean; settled: boolean; active: boolean;
}
export interface WorldDirector {
  setInputs(inputs: WorldInputs): void;
  /** Resolve a static policy immediately, without advancing simulation time. */
  snap(): WorldFrame;
  beginIntro(): void;
  endIntro(): void;
  /** All clock values use monotonic milliseconds, like performance.now(). */
  noteInteraction(now: number): void;
  step(dtSeconds: number, now: number): WorldFrame;
}
const scalarKeys = ["fov", "profile", "mask", "lat", "island", "exposure", "fogD", "bloom", "horizon", "runDim", "dim", "paperInk"] as const;
function sceneValues(input: WorldInputs) {
  const preset = WORLD_PRESETS[input.scene];
  const content = input.page === "content" ? LIST_CAM[input.scene] : null;
  return {
    eye: [...(content?.eye ?? preset.eye)] as Vec3, at: [...(content?.at ?? preset.at)] as Vec3,
    fov: preset.fov, profile: preset.profile, mask: preset.mask, lat: input.material === "lattice" ? 1 : 0,
    island: content ? -18 : input.material === "lattice" ? preset.island : 0, exposure: content?.exposure ?? preset.exposure,
    fogD: preset.fogD, bloom: (content?.bloom ?? preset.bloom)[input.material], horizon: content?.horizon ?? preset.horizon[input.material],
    runDim: content ? .5 : 1, dim: content ? .55 : 1, paperInk: content ? .12 : 1,
  };
}
const approach = (value: number, target: number, amount: number) => Math.abs(value - target) < 1e-6 ? target : value + (target - value) * amount;

export function createWorldDirector(initial: WorldInputs): WorldDirector {
  let inputs = { ...initial };
  const initialValues = sceneValues(inputs);
  const cameraEye: Vec3 = [...initialValues.eye], cameraAt: Vec3 = [...initialValues.at];
  const eyeSprings = cameraEye.map(value => createSpring(value));
  const atSprings = cameraAt.map(value => createSpring(value));
  const frame: WorldFrame = { ...initialValues, page: inputs.page, flash: 0, front: inputs.phase === "preparing" ? FRONT_START : 0, cry: 0, charge: 0, timeScale: 1, simTime: 0, ring: 0,
    morph: { start: -1, dur: .001, toWord: false, fromWord: false, transit: 0 }, introTime: 0, introActive: false, settled: false, active: false };
  let clock: number | null = null;
  let preparationTarget = inputs.phase === "preparing" ? FRONT_START : 0;
  let runningAt: number | null = null;
  let flashAt: number | null = null, flashPending = false;
  let runningFrom = 0;
  let retreatAt: number | null = null, retreatFrom = 0;
  let push = 0;
  let lastInteraction = -Infinity;
  let compositionAt = -Infinity;
  let pendingComposition = false;
  let introAt: number | null = null;
  let introStage = 0;
  let introPlayed = false;

  function endIntro() {
    if (!frame.introActive) return;
    frame.introActive = false; frame.introTime = 0;
    introAt = null;
    introStage = 0;
    frame.morph = { start: frame.simTime, dur: .001, toWord: false, fromWord: false, transit: 0 };
  }

  function snapshot(): WorldFrame { return { ...frame, eye: [...frame.eye], at: [...frame.at], morph: { ...frame.morph } }; }

  return {
    snap() {
      endIntro();
      flashAt = null; flashPending = false; frame.flash = 0;
      const target = sceneValues(inputs);
      if (inputs.phase === "running") { target.exposure = .3; target.bloom = .1; target.runDim = .3; }
      for (const key of scalarKeys) frame[key] = target[key];
      for (let index = 0; index < 3; index++) {
        cameraEye[index] = target.eye[index]; cameraAt[index] = target.at[index];
        snapSpring(eyeSprings[index], target.eye[index]); snapSpring(atSprings[index], target.at[index]);
      }
      push = inputs.phase === "preparing" ? 1 : 0;
      frame.eye = cameraEye.map((value, index) => value + (cameraAt[index] - value) * push * .09 * (index === 1 ? .4 : 1)) as Vec3;
      frame.at = [...cameraAt];
      if (inputs.phase === "preparing") {
        if (inputs.fraction !== null && Number.isFinite(inputs.fraction)) preparationTarget = Math.max(preparationTarget, progressRadius(inputs.fraction));
        frame.front = preparationTarget; frame.cry = preparationTarget;
      } else { frame.front = inputs.phase === "running" ? FRONT_MAX : 0; frame.cry = frame.front; }
      if (inputs.phase === "idle") { retreatAt = clock; retreatFrom = 0; }
      frame.ring = inputs.phase === "preparing" ? frame.front : 0;
      frame.charge = inputs.phase === "preparing" ? 1 : 0;
      frame.timeScale = inputs.phase === "running" ? .12 : 1;
      frame.active = false; frame.settled = inputs.phase === "running";
      frame.morph = { start: frame.simTime, dur: .001, toWord: false, fromWord: false, transit: 0 };
      return snapshot();
    },
    setInputs(next) {
      const compositionChanged = inputs.scene !== next.scene || inputs.material !== next.material || inputs.page !== next.page;
      if (next.phase === "idle" && inputs.phase !== "idle") { retreatAt = null; retreatFrom = frame.cry; }
      else if (next.phase !== "idle") { retreatAt = null; retreatFrom = 0; }
      if (next.phase === "preparing" && inputs.phase !== "preparing") {
        preparationTarget = FRONT_START;
        frame.front = FRONT_START;
        frame.cry = FRONT_START;
        frame.charge = 0;
      } else if (next.phase !== "preparing") preparationTarget = 0;
      if (next.phase === "running" && inputs.phase !== "running") {
        runningAt = clock;
        runningFrom = frame.front;
        if (inputs.phase === "preparing" && next.page === "home") {
          flashAt = clock; flashPending = clock === null;
        }
      } else if (next.phase !== "running") runningAt = null;
      if (next.phase !== "running" || next.page !== "home") { flashAt = null; flashPending = false; frame.flash = 0; }
      if (next.phase !== "idle" || next.page !== "home" || next.material !== "lattice") endIntro();
      if (compositionChanged) {
        frame.morph = { start: frame.simTime, dur: 1.2, toWord: false, fromWord: false, transit: 26 };
        compositionAt = clock ?? -Infinity;
        pendingComposition = clock === null;
      }
      inputs = { ...next };
      frame.page = inputs.page;
    },
    beginIntro() {
      if (introPlayed || inputs.phase !== "idle" || inputs.page !== "home" || inputs.material !== "lattice") return;
      introPlayed = true;
      introAt = clock;
      introStage = 1;
      frame.introActive = true; frame.introTime = 0;
      frame.morph = { start: frame.simTime, dur: .9, toWord: true, fromWord: false, transit: 10 };
    },
    endIntro,
    noteInteraction(now) {
      if (inputs.phase !== "running" && Number.isFinite(now)) lastInteraction = Math.max(clock ?? now, now);
    },
    step(dtSeconds, now) {
      const dt = Number.isFinite(dtSeconds) ? Math.max(0, Math.min(.05, dtSeconds)) : 0;
      const previousClock = clock;
      clock = Number.isFinite(now) ? Math.max(clock ?? now, now) : (clock ?? 0) + dt * 1000;
      const statusDt = previousClock === null ? dt : Math.max(0, (clock - previousClock) / 1000);
      if (flashPending) { flashAt = clock; flashPending = false; }
      const flashElapsed = flashAt === null ? Infinity : clock - flashAt;
      frame.flash = flashElapsed < MOTION.overture.maxMs - 1e-6
        ? MOTION.overture.flashStrength * Math.exp(-flashElapsed / MOTION.overture.decayMs) : 0;
      if (pendingComposition) { compositionAt = clock; pendingComposition = false; }
      if (frame.introActive) {
        introAt ??= clock;
        const elapsed = clock - introAt;
        if (elapsed >= 2500 - 1e-6) endIntro();
        else if (elapsed >= 1400 - 1e-6 && introStage === 1) {
          introStage = 2;
          frame.morph = { start: frame.simTime, dur: 1.1, toWord: false, fromWord: true, transit: 16 };
        }
        if (frame.introActive) frame.introTime = Math.max(0, (elapsed - (introStage === 2 ? 1400 : 0)) / 1000);
      }
      const target = sceneValues(inputs);
      if (frame.introActive) target.island = 0;
      if (inputs.phase === "running") { target.exposure = .3; target.bloom = .1; target.runDim = .3; }
      const amount = 1 - Math.exp(-dt * 2.4);
      for (const key of scalarKeys) frame[key] = approach(frame[key], target[key], amount);
      for (let index = 0; index < 3; index++) {
        eyeSprings[index].goal = target.eye[index]; atSprings[index].goal = target.at[index];
        advanceSpring(eyeSprings[index], dt, MOTION.camera); advanceSpring(atSprings[index], dt, MOTION.camera);
        cameraEye[index] = eyeSprings[index].position; cameraAt[index] = atSprings[index].position;
      }
      push = approach(push, inputs.phase === "preparing" ? 1 : 0, 1 - Math.exp(-dt * 1.3));
      frame.eye = cameraEye.map((value, index) => value + (cameraAt[index] - value) * push * .09 * (index === 1 ? .4 : 1)) as Vec3;
      frame.at = [...cameraAt];
      frame.timeScale = inputs.phase === "running" ? .12 : 1;
      frame.simTime += dt;
      if (inputs.phase === "preparing") {
        const fraction = inputs.fraction;
        const reached = fraction !== null && Number.isFinite(fraction)
          ? progressRadius(fraction) : Math.min(progressRadius(.15), preparationTarget + (FRONT_MAX - FRONT_START) * .02 * statusDt);
        preparationTarget = Math.max(preparationTarget, reached);
        frame.front = approach(frame.front, preparationTarget, 1 - Math.exp(-statusDt * 2.4));
        frame.cry = Math.max(frame.cry, frame.front);
      } else if (inputs.phase === "running") {
        runningAt ??= clock;
        const elapsed = clock - runningAt;
        const fraction = elapsed >= 600 - 1e-6 ? 1 : Math.max(0, elapsed / 600);
        frame.front = runningFrom + (FRONT_MAX - runningFrom) * fraction;
        frame.cry = Math.max(frame.cry, frame.front);
      } else {
        retreatAt ??= clock;
        frame.cry = Math.max(0, retreatFrom - (clock - retreatAt) / 1000 * 75);
        if (frame.cry === 0) frame.front = 0;
      }
      frame.charge = inputs.phase === "preparing" ? Math.min(1, frame.charge + dt * 2)
        : Math.max(0, frame.charge - dt * (inputs.phase === "running" ? .5 : 1.2));
      frame.ring = inputs.phase === "preparing" ? frame.front : 0;
      frame.settled = inputs.phase === "running" && frame.front === FRONT_MAX &&
        Math.abs(frame.exposure - .3) < .001 && Math.abs(frame.bloom - .1) < .001 && Math.abs(frame.runDim - .3) < .001 && frame.charge === 0 && frame.flash === 0;
      frame.active = inputs.phase === "running" ? !frame.settled : frame.introActive || inputs.phase === "preparing" ||
        clock - compositionAt < 2000 || clock - lastInteraction < 1000;
      return snapshot();
    },
  };
}
