// SPDX-License-Identifier: GPL-3.0-only
// Run directly: node tests/unit/character-animation.test.mjs
// Real React, CharacterCanvas, SkinViewer.draw/setters and skinview3d joints;
// only WebGL, image decoding, translation and browser timing need substitutes.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";
import * as skin from "skinview3d";
import { Clock, Group, PerspectiveCamera } from "three";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "HTMLCanvasElement", "MouseEvent", "Event", "MutationObserver"])
  globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = () => null;

let hidden = false;
let reduced = false;
let now = 1000;
let nextFrame = 0;
const frames = new Map();
const viewers = [];
const intersections = [];
const mediaListeners = new Set();
Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
Object.defineProperty(performance, "now", { configurable: true, value: () => now });
window.matchMedia = () => ({
  get matches() { return reduced; },
  addEventListener: (_event, callback) => mediaListeners.add(callback),
  removeEventListener: (_event, callback) => mediaListeners.delete(callback),
  addListener() {},
  removeListener() {},
});
window.requestAnimationFrame = globalThis.requestAnimationFrame = (callback) => {
  const id = ++nextFrame;
  frames.set(id, callback);
  return id;
};
window.cancelAnimationFrame = globalThis.cancelAnimationFrame = (id) => frames.delete(id);
globalThis.IntersectionObserver = class {
  constructor(callback) { this.callback = callback; intersections.push(this); }
  observe() {}
  disconnect() {}
};

class HeadlessViewer {
  constructor(options) {
    // Preserve the installed viewer's animation setters, clock and draw loop.
    // Its normal constructor allocates WebGL, which JSDOM cannot provide.
    const viewer = Object.create(skin.SkinViewer.prototype);
    Object.assign(viewer, {
      canvas: options.canvas,
      _disposed: false,
      _renderPaused: options.renderPaused,
      _animation: null,
      animationID: null,
      clock: new Clock(),
      playerObject: new skin.PlayerObject(),
      playerWrapper: new Group(),
      scene: new Group(),
      camera: new PerspectiveCamera(),
      _zoom: options.zoom,
      autoRotate: false,
      autoRotateSpeed: 1,
      isUserRotating: false,
      controls: { update() {}, addEventListener() {}, removeEventListener() {} },
      composer: { render() {}, dispose() {} },
      fxaaPass: { material: { dispose() {} } },
      renderer: { getContext: () => ({ isContextLost: () => false }), forceContextLoss() {} },
      dispose() {
        this._disposed = true;
        if (this.animationID !== null) window.cancelAnimationFrame(this.animationID);
        this.animationID = null;
      },
    });
    viewers.push(viewer);
    return viewer;
  }
}

const modules = new Map();
function load(relative) {
  const file = path.resolve(workspace, relative);
  if (modules.has(file)) return modules.get(file);
  const module = { exports: {} };
  modules.set(file, module.exports);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const localRequire = (specifier) => {
    if (specifier.endsWith(".css")) return {};
    if (specifier === "skinview3d") return { ...skin, SkinViewer: HeadlessViewer };
    if (specifier === "react-i18next") return { useTranslation: () => ({ t: (key) => key }) };
    if (specifier.endsWith("/skinTexture")) return {
      SkinTextureLoader: class { async load() { return true; } dispose() {} },
      CapeTextureLoader: class { async load() { return true; } dispose() {} },
    };
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(file), specifier);
      const resolved = [base + ".tsx", base + ".ts", base].find(existsSync);
      if (resolved) return load(resolved);
    }
    return require(specifier);
  };
  vm.runInThisContext("(function(exports, require, module) {" + outputText + "\n})", { filename: file })(module.exports, localRequire, module);
  return module.exports;
}

const { CharacterCanvas } = load("src/visual/character/CharacterCanvas.tsx");
let root;
let container;
async function render(props = {}) {
  await act(async () => root.render(React.createElement(CharacterCanvas, { skinUrl: "skin.png", label: "Preview", ...props })));
}
function advance(count = 4) {
  for (let i = 0; i < count; i++) {
    now += 1000 / 60;
    for (const [id, callback] of [...frames]) {
      // A callback can cancel another callback queued in the same frame.
      if (frames.delete(id)) callback(now);
    }
  }
}
function viewer() { return viewers.at(-1); }
function leg() { return viewer().playerObject.skin.leftLeg.rotation.x; }
function assertMoving() {
  const animation = viewer().animation;
  const progress = animation.progress;
  const rotation = leg();
  advance();
  assert.ok(animation.progress > progress, "the real animation clock must advance");
  assert.notEqual(leg(), rotation, "the real walking/running joints must move");
}
async function visibility(value) {
  hidden = !value;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
}
async function intersect(value) {
  await act(async () => intersections[0].callback([{ isIntersecting: value }]));
}

const tests = [];
function test(name, body) { tests.push([name, body]); }

test("idle, walk and run select real animations and advance their joints", async () => {
  for (const [animation, Type] of [["idle", skin.IdleAnimation], ["walk", skin.WalkingAnimation], ["run", skin.PlayerAnimation]]) {
    await render({ animation });
    assert.ok(viewer().animation instanceof Type);
    assert.equal(viewer().renderPaused, false);
    if (animation === "idle") { advance(); assert.ok(viewer().animation.progress > 0); }
    else assertMoving();
  }
  assert.equal(viewers.length, 1, "state transitions must retain the viewer");
});

test("running uses vanilla grounded limbs instead of a jumping showcase pose", async () => {
  await render({ animation: "run" });
  const stride = viewer().animation, player = viewer().playerObject;
  stride.progress = .11789224908397603;
  stride.update(player, 0);
  assert.ok(Math.abs(player.skin.leftLeg.rotation.x - 1.4) < .000001);
  assert.ok(Math.abs(player.skin.rightLeg.rotation.x + 1.4) < .000001);
  assert.ok(Math.abs(player.skin.leftArm.rotation.x + 1.0078659676) < .000001);
  assert.equal(player.position.length(), 0);
  assert.equal(player.rotation.x, 0);
  assert.equal(player.rotation.z, 0);
});

for (const animation of ["walk", "run"]) test(`${animation} freezes its stride during a pause and continues playback on resume`, async () => {
  await render({ animation });
  advance();
  const stride = viewer().animation;
  const progress = stride.progress;
  const rotation = leg();
  await render({ animation, paused: true });
  assert.equal(viewer().renderPaused, true);
  assert.equal(frames.size, 0);
  assert.equal(viewer().animation, stride, "pause must retain the active animation");
  assert.equal(leg(), rotation, "pause must retain the current joint pose");
  now += 60_000;
  advance();
  assert.equal(stride.progress, progress);
  await render({ animation });
  assert.equal(viewer().animation, stride);
  assert.equal(viewer().renderPaused, false);
  assertMoving();
  assert.ok(stride.progress - progress < 0.1, "hidden time must not jump the animation forward");
});

test("document and viewport visibility preserve walking playback and explicit pause", async () => {
  await render({ animation: "walk" });
  advance();
  const stride = viewer().animation;
  const rotation = leg();
  await visibility(false);
  assert.equal(viewer().renderPaused, true);
  assert.equal(viewer().animation, stride);
  assert.equal(leg(), rotation);
  await intersect(true);
  assert.equal(viewer().renderPaused, true, "intersection must not override document visibility");
  await visibility(true);
  assert.equal(viewer().animation, stride);
  assertMoving();
  await intersect(false);
  assert.equal(frames.size, 0);
  assert.equal(viewer().animation, stride);
  await intersect(true);
  assertMoving();
  await render({ animation: "walk", paused: true });
  await intersect(false);
  await intersect(true);
  assert.equal(viewer().renderPaused, true, "viewport re-entry must not override an explicit pause");
  assert.equal(frames.size, 0);
});

test("changing auto rotation retains the running animation and its progress", async () => {
  await render({ animation: "run", interactive: true, autoRotate: false });
  advance();
  const stride = viewer().animation;
  const progress = stride.progress;
  await render({ animation: "run", interactive: true, autoRotate: true });
  assert.equal(viewer().animation, stride);
  assert.equal(stride.progress, progress);
  const rotation = viewer().playerWrapper.rotation.y;
  assertMoving();
  assert.notEqual(viewer().playerWrapper.rotation.y, rotation);
});

test("reduced motion stops walk/run and restores the requested running mode", async () => {
  await render({ animation: "run", interactive: true });
  assertMoving();
  reduced = true;
  await act(async () => { for (const listener of mediaListeners) listener(); });
  assert.equal(viewer().animation, null);
  assert.equal(viewer().autoRotate, false);
  assert.equal(viewer().renderPaused, true);
  assert.equal(frames.size, 0);
  reduced = false;
  await act(async () => { for (const listener of mediaListeners) listener(); });
  assert.ok(viewer().animation instanceof skin.PlayerAnimation);
  assertMoving();
});

test("none remains static while manual auto rotation can still run", async () => {
  await render({ animation: "none", interactive: true, autoRotate: false });
  assert.equal(viewer().animation, null);
  assert.equal(viewer().renderPaused, true);
  assert.equal(frames.size, 0);
  await render({ animation: "none", interactive: true, autoRotate: true });
  const rotation = viewer().playerWrapper.rotation.y;
  advance();
  assert.notEqual(viewer().playerWrapper.rotation.y, rotation);
  assert.equal(leg(), 0);
});

let failed = 0;
for (const [name, body] of tests) {
  hidden = false;
  reduced = false;
  viewers.length = 0;
  intersections.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  try {
    await body();
    console.log("PASS", name);
  } catch (error) {
    failed++;
    console.error("FAIL", name, "\n", error);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    assert.equal(frames.size, 0, "unmount must stop every animation frame");
    assert.equal(mediaListeners.size, 0, "unmount must remove media listeners");
  }
}
dom.window.close();
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
