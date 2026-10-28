import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { test, beforeEach, afterEach } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import ts from "typescript";

// Run the real component and springs without a bundler or a WebGL context.
// Only external UI/provider boundaries are replaced; React and DOM effects run.
const projectRoot = resolve(import.meta.dirname, "../..");
const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const name of ["window", "document", "HTMLElement", "Element", "Event", "MouseEvent"]) {
  globalThis[name] = name === "window" ? dom.window : name === "document" ? dom.window.document : dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let appearance;
let root;
let container;
let frames;
let frameId;
let now;
let observers;
let geometry;
const pageIds = ["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"];

function loadSource(file, cache = new Map()) {
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const nativeRequire = createRequire(file);
  const require = (specifier) => {
    if (specifier.endsWith(".css")) return {};
    if (specifier === "react-i18next") return { useTranslation: () => ({ t: (key) => key }) };
    if (specifier.endsWith("/AppearanceProvider")) return { useAppearance: () => appearance };
    if (specifier.endsWith("/WindowChrome")) return { WindowChrome: ({ children }) => children };
    if (specifier.endsWith("/PlayerAvatar")) return { PlayerAvatar: () => null };
    if (specifier.endsWith("/glass/GlassSystem")) {
      return { GlassSurface: ({ className, children }) => createElement("div", { className }, children) };
    }
    if (!specifier.startsWith(".")) return nativeRequire(specifier);
    const base = resolve(dirname(file), specifier);
    const source = [base, `${base}.ts`, `${base}.tsx`].find((candidate) => existsSync(candidate));
    assert.ok(source, `Cannot resolve ${specifier} from ${file}`);
    return loadSource(source, cache);
  };
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", output)(require, module, module.exports);
  return module.exports;
}

const { FloatingNav } = loadSource(resolve(projectRoot, "src/app/FloatingNav.tsx"));

function rect(x, y, width, height) {
  return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON() {} };
}

const originalBounds = dom.window.HTMLElement.prototype.getBoundingClientRect;
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.classList.contains("vx-floating-nav")) return rect(200, 20, geometry.navWidth, 44);
  const page = this.dataset.page;
  if (page) {
    const item = geometry.items[page];
    return rect(200 + item.x, 20, item.width, 44);
  }
  return originalBounds.call(this);
};

beforeEach(() => {
  appearance = { effects: "full", reducedMotion: false };
  geometry = { navWidth: 850, items: Object.fromEntries(pageIds.map((page, index) => [page, { x: index * 100, width: 72 }])) };
  frames = new Map();
  frameId = 0;
  now = 0;
  observers = new Set();
  globalThis.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.ResizeObserver = class {
    targets = new Set();
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); observers.delete(this); }
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  assert.equal(frames.size, 0, "unmount must cancel all pending animation/measurement frames");
  assert.equal(observers.size, 0, "unmount must disconnect all observers");
});

async function render(page = "settings", props = {}) {
  await act(async () => root.render(createElement(FloatingNav, {
    page, implemented: new Set(pageIds), onNavigate() {}, ...props,
  })));
}

function advance(count = 1) {
  act(() => {
    for (let i = 0; i < count; i++) {
      const pending = [...frames.values()];
      frames.clear();
      now += 1000 / 60;
      for (const callback of pending) callback(now);
    }
  });
}

function flush() {
  for (let i = 0; frames.size && i < 400; i++) advance();
  assert.equal(frames.size, 0, "indicator should reach rest without a continuous frame loop");
}

function notify(element) {
  act(() => {
    for (const observer of observers) {
      if (observer.targets.has(element)) observer.callback([{ target: element, contentRect: element.getBoundingClientRect() }]);
    }
  });
}

function slot() { return container.querySelector(".vx-floating-nav__indicator-slot"); }
function nav() { return container.querySelector("nav"); }
function item(page) { return container.querySelector(`[data-page="${page}"]`); }

test("repositions a recreated indicator when full/lite/reduced-motion preferences change", async () => {
  await render();
  flush();
  assert.equal(slot().style.width, "72px");
  for (const next of [
    { effects: "lite", reducedMotion: false },
    { effects: "full", reducedMotion: false },
    { effects: "full", reducedMotion: true },
    { effects: "full", reducedMotion: false },
  ]) {
    appearance = next;
    await render();
    flush();
    assert.equal(slot().style.width, "72px");
    assert.equal(slot().style.transform, "translate3d(600px, 0px, 0)");
    assert.equal(slot().style.getPropertyValue("--jelly-matrix"), "matrix(1.0000, 0.0000, 0.0000, 1.0000, 0, 0)");
    assert.equal(nav().dataset.motionSettled, "true");
  }
});

test("ignores content reflows and follows active item resizing inside an unchanged nav", async () => {
  await render("downloads");
  flush();
  notify(nav());
  advance();
  assert.equal(frames.size, 0, "an unchanged nav notification should not restart measurement");
  geometry.items.downloads.width = 104;
  await render("downloads", { activeTaskCount: 12 });
  notify(item("downloads"));
  flush();
  assert.equal(slot().style.width, "104px");
  assert.equal(slot().style.getPropertyValue("--jelly-energy"), "0.0000");
  assert.equal(nav().dataset.motionSettled, "true");
});

test("follows active-item movement caused by sibling resizing without a nav resize", async () => {
  await render("library");
  flush();
  geometry.items.home.width = 100;
  geometry.items.library.x = 128;
  notify(item("home"));
  flush();
  assert.equal(slot().style.transform, "translate3d(128px, 0px, 0)");
  assert.equal(slot().style.getPropertyValue("--jelly-energy"), "0.0000");
});

test("keeps genuine navigation elastic and snaps layout updates during an active spring", async () => {
  await render("home");
  flush();
  await render("settings");
  advance(8);
  assert.ok(Number(slot().style.getPropertyValue("--jelly-energy")) > 0, "actual page navigation should stretch");
  geometry.navWidth = 900;
  geometry.items.settings.x = 650;
  notify(nav());
  advance(4);
  assert.equal(slot().style.transform, "translate3d(650px, 0px, 0)");
  assert.equal(slot().style.getPropertyValue("--jelly-energy"), "0.0000");
  flush();
  assert.equal(slot().style.getPropertyValue("--jelly-energy"), "0.0000");
});

test("coalesces repeated layout notifications until the last geometry settles", async () => {
  await render();
  flush();
  for (const x of [610, 620, 630]) {
    geometry.navWidth += 10;
    geometry.items.settings.x = x;
    notify(nav());
    advance();
  }
  advance(4);
  assert.equal(slot().style.transform, "translate3d(630px, 0px, 0)");
  assert.equal(slot().style.getPropertyValue("--jelly-energy"), "0.0000");
  flush();
});

test("uses the current active page when animation frames are unavailable", async () => {
  const requestFrame = globalThis.requestAnimationFrame;
  const cancelFrame = globalThis.cancelAnimationFrame;
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
  try {
    await render("home");
    await render("settings");
    assert.equal(slot().style.transform, "translate3d(600px, 0px, 0)");
  } finally {
    globalThis.requestAnimationFrame = requestFrame;
    globalThis.cancelAnimationFrame = cancelFrame;
  }
});
