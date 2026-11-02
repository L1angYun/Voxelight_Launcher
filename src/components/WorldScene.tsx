// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useRef } from "react";
import type { EffectsLevel } from "../lib/launcher";
import { createWorldDirector, type WorldFrame } from "./world/worldDirector";
import { createWorldRenderer, type RGB, type WorldPalette, type WorldRenderer } from "./world/renderer";
import { createFrameBudget, nextTier, selectTier, type Tier } from "./world/qualityTier";
import type { WorldMaterial, WorldPage, WorldPhase, WorldSceneId } from "./world/types";
import { isBlankPress } from "./world/pointerTarget";
import { publishWorldAvailability } from "./world/worldAvailability";
import "./WorldScene.css";

export interface WorldSceneProps {
  phase: WorldPhase; fraction: number | null; page: WorldPage; scene: WorldSceneId; material: WorldMaterial;
  className?: string; paused?: boolean; effects?: EffectsLevel; reducedMotion?: boolean;
}
function rgb(value: string, fallback: RGB): RGB {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3 ? Array.from(hex, digit => digit + digit).join("") : hex;
    return [0, 2, 4].map(offset => parseInt(expanded.slice(offset, offset + 2), 16) / 255) as [number, number, number];
  }
  const channels = value.match(/^rgba?\(\s*([\d.]+)(%)?[,\s]+([\d.]+)(%)?[,\s]+([\d.]+)(%)?/i);
  if (!channels) return fallback;
  return [1, 3, 5].map(index => Math.min(1, Number(channels[index]) / (channels[index + 1] ? 100 : 255))) as [number, number, number];
}
function palette(): WorldPalette {
  const root = document.documentElement, style = getComputedStyle(root);
  const light = root.dataset.theme === "light";
  const base = rgb(style.getPropertyValue("--bg-base"), light ? [.953, .945, .922] : [.027, .031, .043]);
  return { light, ink: light ? base : [7 / 255, 8 / 255, 11 / 255], point: light ? rgb(style.getPropertyValue("--text-primary"), [.14, .145, .13]) : [236 / 255, 231 / 255, 218 / 255],
    accent: rgb(style.getPropertyValue("--accent"), [180 / 255, 241 / 255, 122 / 255]), haze: light ? base : [.25, .27, .32] };
}

export function WorldScene(props: WorldSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null), canvasRef = useRef<HTMLCanvasElement>(null);
  const current = useRef(props); current.current = props;
  const runtime = useRef<{ update(force?: boolean): void } | null>(null);
  useEffect(() => {
    const host = hostRef.current, canvas = canvasRef.current;
    if (!host || !canvas) return;
    const html = document.documentElement;
    const query = (text: string) => typeof window.matchMedia === "function" ? window.matchMedia(text) : null;
    const reduce = query("(prefers-reduced-motion: reduce)"), contrast = query("(prefers-contrast: more)"), forced = query("(forced-colors: active)"), fine = query("(any-pointer: fine)");
    let disposed = false, lost = false, visible = true, animation: number | null = null;
    let drawn = 0, lastDraw: number | null = null, downgrades = 0, lastKey = "", lastPalette = "";
    let previousTick: number | null = null, lastGpuAt: number | null = null, lastCpuMs = 0;
    let budgetSource: "gpu" | "raf" | null = null;
    let width = 1, height = 1, tier: Tier;
    let lastLayoutKey = "", trackedAnchor: Element | null = null;
    let renderer: WorldRenderer | null = null;
    let pointerBound = false;
    let held: { id: number; start: number; x: number; y: number; moved: number } | null = null;
    let budget = createFrameBudget(16.7);
    const userInputs = () => ({ phase: current.current.phase, fraction: current.current.fraction, page: current.current.page, scene: current.current.scene, material: current.current.material });
    const requestedInputs = () => ({ ...userInputs(), material: !renderer?.capabilities.floatTargets || tier?.forceSolid ? "solid" as WorldMaterial : current.current.material });
    const director = createWorldDirector(userInputs());
    let lastFrame = director.step(0, performance.now());
    const permitted = () => !disposed && !lost && !current.current.paused && !document.hidden && visible;
    function stop() {
      if (animation !== null) cancelAnimationFrame(animation);
      animation = null; lastDraw = null; previousTick = null; lastGpuAt = null; budgetSource = null;
      finishPress();
    }
    function publish(frame: WorldFrame) {
      host!.dataset.worldFrames = String(drawn);
      host!.dataset.worldMaterial = renderer?.material ?? "solid";
      host!.dataset.worldPhase = current.current.phase;
      host!.dataset.worldFront = String(Math.round(frame.front));
      host!.dataset.worldTier = lost || !renderer ? "css" : tier.kind;
      host!.dataset.worldGrid = String(tier.grid);
      host!.dataset.worldParticles = String(renderer?.material === "lattice" ? tier.particleSide ** 2 : 0);
      host!.dataset.worldDpr = (canvas!.width / width).toFixed(3);
      host!.dataset.motion = tier?.kind === "animated" ? "full" : "reduced";
      host!.dataset.paused = String(!permitted());
      lastFrame = frame;
      publishWorldAvailability(lost || !renderer ? "css" : renderer.capabilities.floatTargets ? "available" : "solid-only");
      syncPointerBindings();
    }
    function fallback() { lost = true; stop(); host!.dataset.worldTier = "css"; host!.dataset.paused = "true"; publishWorldAvailability("css"); syncPointerBindings(); }
    function sample(source: "gpu" | "raf", costMs: number, elapsedMs: number) {
      if (tier.kind !== "animated" || elapsedMs <= 0) return;
      if (source !== budgetSource) { budget = createFrameBudget(16.7); budgetSource = source; }
      host!.dataset.worldBudgetSource = source;
      if (budget.sample(costMs, elapsedMs) !== "downgrade") return;
      const next = nextTier(tier);
      if (next) { downgrades++; tier = next; renderer?.setTier(tier); fit(); }
    }
    function paint(now: number, dt: number) {
      if (!renderer || !permitted()) return;
      const frame = tier.kind === "static" ? director.snap() : director.step(dt, now);
      try {
        const floatSupport = renderer.capabilities.floatTargets;
        const result = renderer.draw(frame, dt);
        if (lost) return;
        drawn++; lastDraw = now;
        if (floatSupport !== renderer.capabilities.floatTargets) { update(true); return; }
        if (result) {
          lastCpuMs = result.cpuMs;
          host!.dataset.worldCpuMs = result.cpuMs.toFixed(3);
          host!.dataset.worldGpuMs = result.gpuMs === null ? "unavailable" : result.gpuMs.toFixed(3);
          if (result.gpuMs !== null && Number.isFinite(result.gpuMs)) {
            if (lastGpuAt !== null) sample("gpu", Math.max(result.cpuMs, result.gpuMs), now - lastGpuAt);
            lastGpuAt = now;
          }
        }
        publish(frame);
      } catch { fallback(); }
    }
    function tick(now: number) {
      animation = null;
      if (!permitted() || tier.kind !== "animated" || lastFrame.settled) { publish(lastFrame); return; }
      const callbackGap = previousTick === null ? 0 : Math.max(0, now - previousTick);
      previousTick = now;
      paint(now, lastDraw === null ? 0 : Math.max(0, Math.min(.05, (now - lastDraw) / 1000)));
      // GPU timing and callback cadence stay separate; animated frames are uncapped.
      if (lastGpuAt === null || now - lastGpuAt > 500) {
        try { sample("raf", Math.max(lastCpuMs, callbackGap), callbackGap); } catch { fallback(); }
      }
      start();
    }
    function start() {
      if (renderer && permitted() && tier.kind === "animated" && !lastFrame.settled && animation === null)
        animation = requestAnimationFrame(tick);
    }
    function measureLayout() {
      const rect = host!.getBoundingClientRect();
      const nextWidth = Math.max(1, rect.width || window.innerWidth), nextHeight = Math.max(1, rect.height || window.innerHeight);
      const anchor = document.querySelector("[data-world-anchor]");
      const bounds = anchor?.getBoundingClientRect();
      const ndc: [number, number] = bounds && bounds.width > 0 && bounds.height > 0
        ? [(bounds.left + bounds.width / 2 - rect.left) / nextWidth * 2 - 1, 1 - (bounds.bottom - rect.top) / nextHeight * 2] : [.62, -.66];
      return { width: nextWidth, height: nextHeight, ndc, anchor, key: JSON.stringify([nextWidth, nextHeight, ...ndc, window.devicePixelRatio || 1]) };
    }
    function fit() {
      const next = measureLayout(); width = next.width; height = next.height; lastLayoutKey = next.key;
      if (trackedAnchor !== next.anchor) {
        if (trackedAnchor) resize?.unobserve(trackedAnchor);
        trackedAnchor = next.anchor; if (trackedAnchor) resize?.observe(trackedAnchor);
      }
      renderer?.resize(width, height, Math.min(window.devicePixelRatio || 1, tier.dprCap));
      renderer?.setAnchor(next.ndc);
    }
    function update(force = false) {
      if (disposed) return;
      const input = current.current;
      const reducedMotion = Boolean(input.reducedMotion || reduce?.matches || html.dataset.reducedMotion === "true");
      const highContrast = Boolean(contrast?.matches || forced?.matches || html.dataset.highContrast === "true");
      const nextPalette = palette(), paletteKey = JSON.stringify(nextPalette);
      const key = JSON.stringify([input.phase, input.fraction, input.page, input.scene, input.material, input.paused, input.effects, reducedMotion, highContrast, document.hidden, visible, lost, Boolean(fine?.matches)]);
      if (!force && key === lastKey && paletteKey === lastPalette) return;
      lastKey = key; stop();
      tier = selectTier({ webgl2: Boolean(renderer) && !lost, floatTargets: Boolean(renderer?.capabilities.floatTargets), effects: input.effects ?? "full", reducedMotion, highContrast });
      for (let index = 0; index < downgrades; index++) tier = nextTier(tier) ?? tier;
      budget = createFrameBudget(16.7);
      director.setInputs(requestedInputs());
      if (drawn === 0) director.snap();
      try {
        renderer?.setTier(tier);
        if (paletteKey !== lastPalette) { renderer?.setPalette(nextPalette); lastPalette = paletteKey; }
        fit(); publish(director.step(0, performance.now()));
        if (renderer && permitted() && tier.kind !== "css") paint(performance.now(), 0);
        start();
      } catch { fallback(); }
    }
    try {
      renderer = createWorldRenderer(canvas, { onLost: fallback, onRestored: () => { if (!disposed) { lost = false; update(true); } } });
    } catch { renderer = null; }
    const ndc = (event: PointerEvent): [number, number] => {
      const rect = host.getBoundingClientRect();
      return [(event.clientX - rect.left) / width * 2 - 1, 1 - (event.clientY - rect.top) / height * 2];
    };
    const move = (event: PointerEvent) => {
      if (!permitted() || tier.kind !== "animated" || !fine?.matches || event.pointerType === "touch" || lastFrame.settled) return;
      renderer?.setPointer(ndc(event));
      if (held && held.id === event.pointerId) held.moved = Math.max(held.moved, Math.hypot(event.clientX - held.x, event.clientY - held.y));
      director.noteInteraction(performance.now()); start();
    };
    const down = (event: PointerEvent) => {
      if (!permitted() || tier.kind !== "animated" || !fine?.matches || event.pointerType === "touch" || event.button !== 0 || current.current.page !== "home" || lastFrame.settled || !isBlankPress(event.target) || held) return;
      held = { id: event.pointerId, start: performance.now(), x: event.clientX, y: event.clientY, moved: 0 };
      renderer?.setPointer(ndc(event)); renderer?.press(ndc(event)); director.noteInteraction(performance.now()); start();
    };
    function finishPress(event?: PointerEvent, tap = false) {
      if (!held || event && event.pointerId !== held.id) return;
      const shock = tap && event && performance.now() - held.start < 300 && held.moved < 8 && (renderer?.melt ?? 0) < .3 && isBlankPress(event.target);
      held = null; renderer?.release();
      if (shock && event) renderer?.shock(ndc(event));
    }
    const up = (event: PointerEvent) => { finishPress(event, true); director.noteInteraction(performance.now()); start(); };
    const cancel = (event: PointerEvent) => finishPress(event);
    const leave = () => { finishPress(); renderer?.setPointer(null); };
    function syncPointerBindings() {
      const bind = permitted() && tier?.kind === "animated" && Boolean(fine?.matches) && !lastFrame.settled;
      if (bind === pointerBound) return;
      pointerBound = bind;
      const handlers: Array<[string, EventListener]> = [["pointermove", move as EventListener], ["pointerdown", down as EventListener], ["pointerup", up as EventListener], ["pointercancel", cancel as EventListener], ["pointerleave", leave], ["blur", leave]];
      if (!bind) leave();
      for (const [name, handler] of handlers) {
        if (bind) window.addEventListener(name, handler, { passive: true });
        else window.removeEventListener(name, handler);
      }
    }
    const changed = () => update();
    const resized = () => { if (measureLayout().key !== lastLayoutKey) update(true); };
    const mutations = new MutationObserver(records => { if (records.some(record => record.target === html)) update(); });
    mutations.observe(html, { attributes: true, attributeFilter: ["data-theme", "data-effects", "data-high-contrast", "data-reduced-motion", "style", "class"] });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resized);
    resize?.observe(host);
    const intersection = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting); update();
    });
    intersection?.observe(host);
    const queries = [reduce, contrast, forced, fine];
    queries.forEach(value => value?.addEventListener?.("change", changed));
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("resize", resized);
    runtime.current = { update }; update();
    return () => {
      disposed = true; stop(); runtime.current = null;
      syncPointerBindings(); publishWorldAvailability("unknown");
      mutations.disconnect(); resize?.disconnect(); intersection?.disconnect();
      queries.forEach(value => value?.removeEventListener?.("change", changed));
      document.removeEventListener("visibilitychange", changed); window.removeEventListener("resize", resized);
      renderer?.dispose();
    };
  }, []);
  useEffect(() => runtime.current?.update(), [props.phase, props.fraction, props.page, props.scene, props.material, props.paused, props.effects, props.reducedMotion]);
  return <div ref={hostRef} className={["world-scene", props.className].filter(Boolean).join(" ")} aria-hidden="true"
    data-world-tier="css" data-world-material="solid" data-world-phase={props.phase} data-world-front="0" data-world-frames="0" data-motion="reduced" data-paused={Boolean(props.paused)}>
    <canvas ref={canvasRef} className="world-scene__canvas" />
  </div>;
}
