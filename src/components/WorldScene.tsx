// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useRef } from "react";
import type { EffectsLevel } from "../lib/launcher";
import { createWorldDirector, type WorldFrame } from "./world/worldDirector";
import { createWorldRenderer, type RGB, type WorldPalette, type WorldRenderer } from "./world/renderer";
import { createFrameBudget, frameIntervalMs, nextTier, selectTier, type Tier } from "./world/qualityTier";
import type { WorldMaterial, WorldPage, WorldPhase, WorldSceneId } from "./world/types";
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
    let renderer: WorldRenderer | null = null;
    let budget = createFrameBudget(16.7);
    const requestedInputs = () => ({ phase: current.current.phase, fraction: current.current.fraction, page: current.current.page, scene: current.current.scene,
      // Task 4 renders solid; Task 5 enables the requested particle material.
      material: renderer?.material ?? "solid" as WorldMaterial });
    const director = createWorldDirector(requestedInputs());
    let lastFrame = director.step(0, performance.now());
    const permitted = () => !disposed && !lost && !current.current.paused && !document.hidden && visible;
    function stop() {
      if (animation !== null) cancelAnimationFrame(animation);
      animation = null; lastDraw = null; previousTick = null; lastGpuAt = null; budgetSource = null;
    }
    function publish(frame: WorldFrame) {
      host!.dataset.worldFrames = String(drawn);
      host!.dataset.worldMaterial = renderer?.material ?? "solid";
      host!.dataset.worldPhase = current.current.phase;
      host!.dataset.worldTier = lost || !renderer ? "css" : tier.kind;
      host!.dataset.motion = tier?.kind === "animated" ? "full" : "reduced";
      host!.dataset.paused = String(!permitted());
      lastFrame = frame;
    }
    function fallback() { lost = true; stop(); host!.dataset.worldTier = "css"; host!.dataset.paused = "true"; }
    function sample(source: "gpu" | "raf", costMs: number, elapsedMs: number) {
      if (tier.kind !== "animated" || elapsedMs <= 0) return;
      if (source !== budgetSource) { budget = createFrameBudget(16.7); budgetSource = source; }
      if (budget.sample(costMs, elapsedMs) !== "downgrade") return;
      const next = nextTier(tier);
      if (next) { downgrades++; tier = next; renderer?.setTier(tier); fit(); }
    }
    function paint(now: number, dt: number) {
      if (!renderer || !permitted()) return;
      const frame = tier.kind === "static" ? director.snap() : director.step(dt, now);
      try {
        const result = renderer.draw(frame, dt);
        if (lost) return;
        drawn++; lastDraw = now;
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
      if (lastDraw === null || now - lastDraw + .2 >= frameIntervalMs(lastFrame.active)) {
        paint(now, lastDraw === null ? 0 : Math.max(0, Math.min(.05, (now - lastDraw) / 1000)));
      }
      // This is the unthrottled callback cadence, not the intentional idle draw gap.
      if (lastGpuAt === null || now - lastGpuAt > 500) {
        try { sample("raf", Math.max(lastCpuMs, callbackGap), callbackGap); } catch { fallback(); }
      }
      start();
    }
    function start() {
      if (renderer && permitted() && tier.kind === "animated" && !lastFrame.settled && animation === null)
        animation = requestAnimationFrame(tick);
    }
    function fit() {
      const rect = host!.getBoundingClientRect();
      width = Math.max(1, rect.width || window.innerWidth); height = Math.max(1, rect.height || window.innerHeight);
      renderer?.resize(width, height, Math.min(window.devicePixelRatio || 1, tier.dprCap));
      renderer?.setAnchor([.62, -.66]);
    }
    function update(force = false) {
      if (disposed) return;
      const input = current.current;
      const reducedMotion = Boolean(input.reducedMotion || reduce?.matches || html.dataset.reducedMotion === "true");
      const highContrast = Boolean(contrast?.matches || forced?.matches || html.dataset.highContrast === "true");
      const nextPalette = palette(), paletteKey = JSON.stringify(nextPalette);
      const key = JSON.stringify([input.phase, input.fraction, input.page, input.scene, input.material, input.paused, input.effects, reducedMotion, highContrast, document.hidden, visible, lost]);
      if (!force && key === lastKey && paletteKey === lastPalette) return;
      lastKey = key; stop();
      tier = selectTier({ webgl2: Boolean(renderer) && !lost, floatTargets: Boolean(renderer?.capabilities.floatTargets), effects: input.effects ?? "full", reducedMotion, highContrast });
      for (let index = 0; index < downgrades; index++) tier = nextTier(tier) ?? tier;
      budget = createFrameBudget(16.7);
      director.setInputs(requestedInputs());
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
    const move = (event: PointerEvent) => {
      if (!permitted() || tier.kind !== "animated" || !fine?.matches || event.pointerType === "touch" || lastFrame.settled) return;
      const rect = host.getBoundingClientRect();
      renderer?.setPointer([(event.clientX - rect.left) / width * 2 - 1, 1 - (event.clientY - rect.top) / height * 2]);
      director.noteInteraction(performance.now()); start();
    };
    const leave = () => { renderer?.setPointer(null); };
    const changed = () => update();
    const resized = () => update(true);
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
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerleave", leave); window.addEventListener("blur", leave);
    runtime.current = { update }; update();
    return () => {
      disposed = true; stop(); runtime.current = null;
      mutations.disconnect(); resize?.disconnect(); intersection?.disconnect();
      queries.forEach(value => value?.removeEventListener?.("change", changed));
      document.removeEventListener("visibilitychange", changed); window.removeEventListener("resize", resized);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerleave", leave); window.removeEventListener("blur", leave);
      renderer?.dispose();
    };
  }, []);
  useEffect(() => runtime.current?.update(), [props.phase, props.fraction, props.page, props.scene, props.material, props.paused, props.effects, props.reducedMotion]);
  return <div ref={hostRef} className={["world-scene", props.className].filter(Boolean).join(" ")} aria-hidden="true"
    data-world-tier="css" data-world-material="solid" data-world-phase={props.phase} data-world-frames="0" data-motion="reduced" data-paused={Boolean(props.paused)}>
    <canvas ref={canvasRef} className="world-scene__canvas" />
  </div>;
}
