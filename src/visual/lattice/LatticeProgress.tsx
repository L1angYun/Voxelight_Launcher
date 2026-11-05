import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
} from "react";
import { cn } from "../../lib/utils";
import {
  LatticeProgressField,
  PROGRESS_FIELD_HEIGHT_PX,
  type ProgressPalette,
} from "./progressField";
import { useLatticeStaticMotion } from "./staticMotion";
import type { LatticeStatus } from "./model";
import "./lattice.css";

const pendingMeasurements = new Map<HTMLCanvasElement, (width: number) => void>();
function queueMeasurement(canvas: HTMLCanvasElement, apply: (width: number) => void) {
  const scheduled = pendingMeasurements.size > 0;
  pendingMeasurements.set(canvas, apply);
  if (scheduled) return;
  queueMicrotask(() => {
    // Read the whole list before changing a bitmap. Interleaved row reads and
    // writes otherwise force a separate layout for every mounted progress field.
    const measured = [...pendingMeasurements].map(([element, resize]) => ({
      resize, width: element.getBoundingClientRect().width || element.clientWidth || 300,
    }));
    pendingMeasurements.clear();
    for (const { resize, width } of measured) resize(width);
  });
}

function readPalette(): ProgressPalette {
  if (typeof window === "undefined") {
    return { gas: "rgba(255,255,255,0.38)", solid: "#84f068", flash: "#ffffff" };
  }
  const style = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    gas: get("--text-tertiary", "rgba(255,255,255,0.38)"),
    solid: get("--accent-indicator", get("--accent", "#b4f17a")),
    flash: get("--text-primary", "#ece7da"),
  };
}

export function LatticeProgress({
  completed,
  total,
  status = "active",
  label,
  unit = "bytes",
  animated = true,
  className,
}: {
  completed: number;
  total: number;
  status?: LatticeStatus;
  label: string;
  unit?: "bytes" | "items";
  animated?: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<LatticeProgressField | null>(null);
  const frameRef = useRef<number | null>(null);
  const staticPaintRef = useRef<(() => void) | null>(null);
  const prevTimeRef = useRef<number>(0);
  const staticMotion = useLatticeStaticMotion();
  const noAnimation = staticMotion || !animated;

  const determinate = Number.isFinite(total) && total > 0;
  const safeCompleted = determinate
    ? Math.max(0, Math.min(Number.isFinite(completed) ? completed : 0, total))
    : 0;
  const fraction = determinate ? safeCompleted / total : 0;
  const percent = determinate ? Math.round(fraction * 100) : null;
  const progressRef = useRef({ determinate, fraction, status, noAnimation });
  progressRef.current = { determinate, fraction, status, noAnimation };

  // Build or resize the field whenever the canvas size changes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let started = false, disposed = false;
    const dpr = Math.min(2, typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
    const resize = (width: number) => {
      const w = Math.round(width);
      const h = PROGRESS_FIELD_HEIGHT_PX;
      const pixelWidth = Math.round(w * dpr);
      const pixelHeight = Math.round(h * dpr);
      const resized = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      if (!fieldRef.current) fieldRef.current = new LatticeProgressField(2);
      const progress = progressRef.current;
      if (!progress.determinate || progress.status === "unknown") fieldRef.current.setScanning();
      else fieldRef.current.setTarget(progress.fraction);
      fieldRef.current.resize(w, h);
      if (progress.noAnimation) fieldRef.current.settle();
      if (resized) staticPaintRef.current?.();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) resize(width);
      else resize(canvas.getBoundingClientRect().width || canvas.clientWidth || 300);
    });
    const initialize = () => {
      if (started || disposed) return;
      started = true;
      queueMeasurement(canvas, resize);
      observer?.observe(canvas);
    };
    // Task labels, actions and aria progress remain in the DOM. Only a static
    // bitmap waits until near the viewport; active progress starts immediately.
    const visibility = !animated && typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { visibility?.disconnect(); initialize(); }
      }, { rootMargin: "120px 0px" }) : null;
    if (visibility) visibility.observe(canvas);
    else initialize();
    return () => { disposed = true; pendingMeasurements.delete(canvas); observer?.disconnect(); visibility?.disconnect(); };
  }, [animated]);

  // Sync the progress target and scanning state to the field.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    if (!determinate || status === "unknown") {
      field.setScanning();
    } else {
      field.setTarget(fraction);
    }
    if (noAnimation) field.settle();
  });

  // Rendering loop.
  // Dependencies include fraction and status so that in noAnimation mode a
  // re-render is triggered whenever the progress value or status changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
    let stopped = false;
    let palette = readPalette();

    const paint = () => {
      const field = fieldRef.current;
      if (!field || stopped) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.save();
      ctx.scale(dpr, dpr);
      field.draw(ctx, palette);
      ctx.restore();
    };

    const tick = (time: number) => {
      frameRef.current = null;
      if (stopped) return;
      const field = fieldRef.current;
      if (!field) return;
      const dt = prevTimeRef.current ? Math.min(0.08, (time - prevTimeRef.current) / 1000) : 1 / 60;
      prevTimeRef.current = time;
      // drift=false in static/noAnimation mode: cloud snaps, no sway
      const needsMore = field.step(dt, /* drift= */ !noAnimation);
      paint();
      if (needsMore && !noAnimation) frameRef.current = requestAnimationFrame(tick);
      else prevTimeRef.current = 0;
    };

    staticPaintRef.current = noAnimation ? paint : null;
    const themeObserver = new MutationObserver(() => { palette = readPalette(); paint(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-color-scheme", "style", "class"] });
    if (noAnimation) {
      // One paint whenever fraction/status changes (effect re-runs on those deps).
      paint();
    } else {
      prevTimeRef.current = 0;
      frameRef.current = requestAnimationFrame(tick);
    }

    return () => {
      stopped = true;
      themeObserver.disconnect();
      staticPaintRef.current = null;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      prevTimeRef.current = 0;
    };
  // fraction and status are included so noAnimation mode repaints on every change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noAnimation, determinate, fraction, status]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("vx-lattice-progress", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? total : undefined}
      aria-valuenow={determinate ? safeCompleted : undefined}
      aria-valuetext={percent !== null ? `${percent}%` : label}
      data-status={status}
      data-unit={unit}
      data-determinate={determinate}
      data-percent={percent ?? undefined}
      style={{ "--lattice-progress-height": `${PROGRESS_FIELD_HEIGHT_PX}px` } as CSSProperties}
    />
  );
}
