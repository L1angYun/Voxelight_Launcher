/**
 * Lattice cursor halo — 30 points that follow the pointer and re-form along a
 * control's rounded outline when the pointer enters one. On fine-pointer devices
 * only; touch screens and reduced-motion skip this entirely.
 *
 * GPL-3.0-only, original implementation.
 */

import { DotField, seededRandom } from "./dots";

const HALO_COUNT = 30;
const HALO_STIFFNESS = 140;
const HALO_DAMPING = 12;

const TARGETS = [
  "a[href]",
  "button:not([disabled])",
  "[role='tab']",
  "[role='switch']",
  "[role='option']",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[data-halo]",
].join(",");

function roundRectPoint(
  bx: number, by: number, bw: number, bh: number,
  r: number, s: number,
): [number, number] {
  const rr = Math.min(r, bw / 2, bh / 2);
  const sw = bw - 2 * rr;
  const sh = bh - 2 * rr;
  const arc = (Math.PI / 2) * rr;
  const total = 2 * sw + 2 * sh + 4 * arc;
  let d = (((s % 1) + 1) % 1) * total;
  const segments: [number, (u: number) => [number, number]][] = [
    [sw, (u) => [bx + rr + u, by]],
    [arc, (u) => { const a = -Math.PI / 2 + u / rr; return [bx + bw - rr + Math.cos(a) * rr, by + rr + Math.sin(a) * rr]; }],
    [sh, (u) => [bx + bw, by + rr + u]],
    [arc, (u) => { const a = u / rr; return [bx + bw - rr + Math.cos(a) * rr, by + bh - rr + Math.sin(a) * rr]; }],
    [sw, (u) => [bx + bw - rr - u, by + bh]],
    [arc, (u) => { const a = Math.PI / 2 + u / rr; return [bx + rr + Math.cos(a) * rr, by + bh - rr + Math.sin(a) * rr]; }],
    [sh, (u) => [bx, by + bh - rr - u]],
    [arc, (u) => { const a = Math.PI + u / rr; return [bx + rr + Math.cos(a) * rr, by + rr + Math.sin(a) * rr]; }],
  ];
  for (const [len, f] of segments) {
    if (d <= len) return f(d);
    d -= len;
  }
  return [bx + rr, by];
}

export interface CursorHalo {
  dispose: () => void;
  setEnabled: (enabled: boolean) => void;
}

export function mountCursorHalo(container: HTMLElement): CursorHalo | null {
  if (typeof window === "undefined") return null;
  if (!window.matchMedia("(pointer: fine)").matches) return null;

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999";
  canvas.setAttribute("aria-hidden", "true");
  container.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) { canvas.remove(); return null; }

  // Keep a stable reference so the tick function never sees null
  const g = ctx;

  let dpr = Math.min(2, devicePixelRatio || 1);
  const fit = () => {
    dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();
  window.addEventListener("resize", fit);

  const dots = new DotField(HALO_COUNT, seededRandom(42));
  dots.stiffness = HALO_STIFFNESS;
  dots.damping = HALO_DAMPING;

  let px = -200;
  let py = -200;
  let inside = false;
  let target: Element | null = null;
  let lastTarget: Element | null = null;
  let spin = 0;
  let rafId: number | null = null;
  let prevTime = 0;

  // Resolve accent and secondary colors from CSS custom properties
  function resolveColors(): { hot: string; cold: string } {
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue("--accent").trim() || "rgba(132,240,104,0.85)";
    const cold = style.getPropertyValue("--optical-cold").trim() || "rgba(140,200,255,0.72)";
    return { hot: accent, cold };
  }

  function onPointerMove(event: PointerEvent) {
    if (event.pointerType === "touch") return;
    const prevInside = inside;
    px = event.clientX;
    py = event.clientY;
    inside = true;
    if (!prevInside) {
      for (let i = 0; i < HALO_COUNT; i++) dots.place(i, px, py);
    }
    const t = (event.target as Element).closest?.(TARGETS) as Element | null;
    target = t && !t.closest("[aria-hidden='true']") ? t : null;
    if (!rafId) schedule();
  }

  function onPointerLeave() {
    inside = false;
    target = null;
  }

  function onPointerDown() {
    if (!inside) return;
    dots.burst(px, py, 180);
  }

  function onFocusIn(event: FocusEvent) {
    const el = event.target as Element;
    if (!el.matches?.(":focus-visible")) return;
    if (!el.matches?.(TARGETS)) return;
    target = el;
    if (!rafId) schedule();
  }

  function onFocusOut() {
    setTimeout(() => {
      if (document.activeElement === document.body) target = null;
    }, 0);
  }

  function schedule() {
    rafId = requestAnimationFrame(tick);
  }

  function tick(now: number) {
    rafId = null;
    const dt = prevTime ? Math.min(0.05, (now - prevTime) / 1000) : 1 / 60;
    prevTime = now;
    spin += dt;

    const { hot, cold } = resolveColors();

    if (target && target.isConnected) {
      const r = target.getBoundingClientRect();
      const pad = 6;
      const bx = r.left - pad;
      const by = r.top - pad;
      const bw = r.width + pad * 2;
      const bh = r.height + pad * 2;
      const radius = (parseFloat(getComputedStyle(target as HTMLElement).borderRadius) || 0) + pad;

      if (lastTarget !== target) {
        dots.stagger(0.14, (i) => {
          const cx = bx + bw / 2;
          const cy = by + bh / 2;
          return Math.hypot(dots.x[i] - cx, dots.y[i] - cy);
        });
        lastTarget = target;
      }
      for (let i = 0; i < HALO_COUNT; i++) {
        const [x, y] = roundRectPoint(bx, by, bw, bh, radius, i / HALO_COUNT + spin * 0.035);
        dots.setHome(i, x, y, 0.95);
      }
    } else {
      lastTarget = null;
      const R = 12;
      for (let i = 0; i < HALO_COUNT; i++) {
        const a = (i / HALO_COUNT) * Math.PI * 2 + spin * 0.6;
        dots.setHome(i, px + Math.cos(a) * R, py + Math.sin(a) * R, i % 3 === 0 ? 0.8 : 0);
      }
    }

    dots.step(dt);

    g.clearRect(0, 0, innerWidth, innerHeight);
    if (!inside && !target) { prevTime = 0; return; }

    const useColor = target ? cold : hot;
    for (let i = 0; i < HALO_COUNT; i++) {
      const alpha = Math.min(1, dots.alpha[i]);
      if (alpha < 0.02) continue;
      g.globalAlpha = alpha;
      g.fillStyle = useColor;
      const radius = (1.25 + dots.heat[i] * 0.4) * (1 + dots.heat[i] * 0.6);
      g.beginPath();
      g.arc(dots.x[i], dots.y[i], radius, 0, Math.PI * 2);
      g.fill();
    }

    // Center dot while free-floating
    if (inside && !target) {
      g.globalAlpha = 0.9;
      g.fillStyle = hot;
      g.beginPath();
      g.arc(px, py, 2.2, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    if (inside || target) schedule();
    else prevTime = 0;
  }

  return {
    dispose() {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("resize", fit);
      if (rafId !== null) cancelAnimationFrame(rafId);
      canvas.remove();
    },
    setEnabled(enabled: boolean) {
      canvas.style.opacity = enabled ? "1" : "0";
      if (!enabled) {
        inside = false;
        target = null;
      }
    },
  };
}
