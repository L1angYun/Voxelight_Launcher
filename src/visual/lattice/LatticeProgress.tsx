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

// Cached palette — refreshed on html[data-theme] changes via MutationObserver.
let cachedPalette: ProgressPalette | null = null;

function readPalette(): ProgressPalette {
  if (typeof window === "undefined") {
    return { gas: "rgba(255,255,255,0.38)", solid: "#84f068", flash: "#ffffff" };
  }
  const style = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    gas: get("--lattice-ink", "rgba(255,255,255,0.38)"),
    solid: get("--lattice-hot", "#84f068"),
    flash: "#ffffff",
  };
}

function palette(): ProgressPalette {
  if (!cachedPalette) cachedPalette = readPalette();
  return cachedPalette;
}

// Watch html[data-theme] (and any attribute change on <html>) to bust the cache.
if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
  const themeObserver = new MutationObserver(() => {
    cachedPalette = null;
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-color-scheme", "class"],
  });
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

  // Build or resize the field whenever the canvas size changes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.round(rect.width || canvas.clientWidth || 300);
      const h = PROGRESS_FIELD_HEIGHT_PX;
      const pixelWidth = Math.round(w * dpr);
      const pixelHeight = Math.round(h * dpr);
      const resized = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      canvas.style.height = `${h}px`;
      if (!fieldRef.current) fieldRef.current = new LatticeProgressField(2);
      fieldRef.current.resize(w, h);
      if (resized) staticPaintRef.current?.();
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

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

    const paint = () => {
      const field = fieldRef.current;
      if (!field || stopped) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.save();
      ctx.scale(dpr, dpr);
      field.draw(ctx, palette());
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
    if (noAnimation) {
      // One paint whenever fraction/status changes (effect re-runs on those deps).
      paint();
    } else {
      prevTimeRef.current = 0;
      frameRef.current = requestAnimationFrame(tick);
    }

    return () => {
      stopped = true;
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
