import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { relativeRect, intersectRects } from "./geometry";
import { readGlassOptics } from "./optics";
import { createGlassRenderer } from "./renderer";
import type { GlassMode, GlassQuality, GlassRenderer, GlassSurfaceModel, GlassVariant } from "./types";
import { cn } from "../../lib/utils";
import "./glass.css";

const presets: Record<GlassVariant, { radius: number; opacity: number }> = {
  nav: { radius: 22, opacity: 0.32 },
  control: { radius: 999, opacity: 0.28 },
  dialog: { radius: 24, opacity: 0.7 },
  toast: { radius: 16, opacity: 0.56 },
};

interface RegisteredSurface {
  element: HTMLElement;
  variant: GlassVariant;
  active: boolean;
}

interface GlassContextValue {
  register: (id: string, surface: RegisteredSurface) => void;
  unregister: (id: string) => void;
}

const GlassContext = createContext<GlassContextValue | null>(null);

export function GlassProvider({
  effects = "full",
  reducedMotion = false,
  reducedTransparency = false,
  highContrast = false,
  background,
  className,
  children,
}: {
  effects?: GlassQuality;
  reducedMotion?: boolean;
  reducedTransparency?: boolean;
  highContrast?: boolean;
  background?: TexImageSource | null;
  className?: string;
  children?: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GlassRenderer | null>(null);
  const surfacesRef = useRef(new Map<string, RegisteredSurface>());
  const preferencesRef = useRef({ reducedMotion, reducedTransparency, highContrast });
  preferencesRef.current = { reducedMotion, reducedTransparency, highContrast };
  const intersectingRef = useRef(true);
  const pointerRef = useRef({ x: -1, y: -1 });
  const [nativeMode, setNativeMode] = useState<GlassMode>("full");
  const [surfaceCount, setSurfaceCount] = useState(0);
  const mode = reducedTransparency || highContrast ? "fallback" : nativeMode;

  const updateFrame = useCallback(() => {
    const preferences = preferencesRef.current;
    rendererRef.current?.update({
      time: performance.now(),
      accent: getComputedStyle(rootRef.current ?? document.documentElement)
        .getPropertyValue("--accent")
        .trim() || "#b4f17a",
      motion: !preferences.reducedMotion && !preferences.reducedTransparency && !preferences.highContrast,
      light: document.documentElement.dataset.theme === "light",
      pointer: pointerRef.current,
    });
  }, []);

  const syncPause = useCallback(() => {
    const preferences = preferencesRef.current;
    rendererRef.current?.pause(document.hidden || !intersectingRef.current ||
      preferences.reducedMotion || preferences.reducedTransparency || preferences.highContrast);
  }, []);

  const syncSurface = useCallback((id: string, surface: RegisteredSurface) => {
    const root = rootRef.current;
    const renderer = rendererRef.current;
    if (!root || !renderer) return;
    const preset = presets[surface.variant];
    const rootBounds = root.getBoundingClientRect();
    const rect = relativeRect(rootBounds, surface.element.getBoundingClientRect());
    let clip = rect;
    for (let parent = surface.element.parentElement; parent && parent !== root; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) {
        clip = intersectRects(clip, relativeRect(rootBounds, parent.getBoundingClientRect()));
      }
    }
    const optics = readGlassOptics(surface.element);
    const model: GlassSurfaceModel = {
      id,
      rect,
      clip,
      radius: Number.parseFloat(getComputedStyle(surface.element).borderTopLeftRadius) || preset.radius,
      variant: surface.variant,
      active: surface.active,
      opacity: preset.opacity,
      ...(optics ? { optics } : {}),
    };
    renderer.upsert(model);
  }, []);

  // A control that publishes live deformation is measured again on every frame,
  // so the glass follows its spring-driven position, bend and pressure.
  const syncLiveSurfaces = useCallback(() => {
    for (const [id, surface] of surfacesRef.current) {
      if (readGlassOptics(surface.element)) syncSurface(id, surface);
    }
  }, [syncSurface]);

  const register = useCallback((id: string, surface: RegisteredSurface) => {
    surfacesRef.current.set(id, surface);
    setSurfaceCount(surfacesRef.current.size);
    syncSurface(id, surface);
  }, [syncSurface]);

  const unregister = useCallback((id: string) => {
    surfacesRef.current.delete(id);
    setSurfaceCount(surfacesRef.current.size);
    rendererRef.current?.remove(id);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const renderer = createGlassRenderer(canvas, { onModeChange: setNativeMode, beforeFrame: syncLiveSurfaces });
    rendererRef.current = renderer;
    setNativeMode(renderer.mode);
    renderer.setQuality(effects);
    renderer.setBackground(background ?? null);
    const resize = () => {
      const bounds = root.getBoundingClientRect();
      renderer.resize(bounds.width, bounds.height, window.devicePixelRatio || 1);
      for (const [id, surface] of surfacesRef.current) syncSurface(id, surface);
      updateFrame();
    };
    const syncPositions = () => {
      for (const [id, surface] of surfacesRef.current) syncSurface(id, surface);
      updateFrame();
    };
    resize();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    resizeObserver?.observe(root);
    const intersectionObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            intersectingRef.current = entry.isIntersecting;
            syncPause();
          });
    intersectionObserver?.observe(root);
    const onVisibility = () => { syncPause(); if (!document.hidden) syncPositions(); };
    const onPointer = (event: PointerEvent) => {
      const bounds = root.getBoundingClientRect();
      pointerRef.current = { x: (event.clientX - bounds.left) / Math.max(1, bounds.width), y: 1 - (event.clientY - bounds.top) / Math.max(1, bounds.height) };
      updateFrame();
    };
    const onPointerLeave = () => { pointerRef.current = { x: -1, y: -1 }; updateFrame(); };
    document.addEventListener("visibilitychange", onVisibility);
    root.addEventListener("pointermove", onPointer, { passive: true });
    root.addEventListener("pointerleave", onPointerLeave);
    root.addEventListener("scroll", syncPositions, { capture: true, passive: true });
    const themeObserver = new MutationObserver(updateFrame);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => {
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      root.removeEventListener("pointermove", onPointer);
      root.removeEventListener("pointerleave", onPointerLeave);
      root.removeEventListener("scroll", syncPositions, true);
      themeObserver.disconnect();
      renderer.dispose();
      rendererRef.current = null;
    };
    // The provider owns one renderer for its lifetime; quality and accessibility
    // updates are applied by the effect below without recreating the context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setQuality(effects);
    syncPause();
    updateFrame();
  }, [effects, highContrast, reducedMotion, reducedTransparency, syncPause, updateFrame]);

  useEffect(() => {
    rendererRef.current?.setBackground(background ?? null);
    updateFrame();
  }, [background, updateFrame]);

  const context = useMemo(() => ({ register, unregister }), [register, unregister]);

  return (
    <div
      ref={rootRef}
      className={cn("vx-glass-provider", className)}
      data-glass-mode={mode}
      data-glass-surface-count={surfaceCount}
    >
      <canvas ref={canvasRef} className="vx-glass-canvas" aria-hidden="true" />
      <GlassContext.Provider value={context}>
        <div className="vx-glass-content">{children}</div>
      </GlassContext.Provider>
    </div>
  );
}

export function GlassSurface({
  id,
  variant = "control",
  active = true,
  className,
  style,
  children,
}: {
  id?: string;
  variant?: GlassVariant;
  active?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const generatedId = useId();
  const surfaceId = id ?? `glass-${generatedId}`;
  const elementRef = useRef<HTMLDivElement>(null);
  const context = useContext(GlassContext);
  if (!context) throw new Error("GlassSurface must be used inside GlassProvider");

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const surface = { element, variant, active };
    context.register(surfaceId, surface);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => context.register(surfaceId, surface));
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      context.unregister(surfaceId);
    };
  }, [active, context, surfaceId, variant]);

  return (
    <div
      ref={elementRef}
      className={cn("vx-glass-surface", `vx-glass-surface--${variant}`, className)}
      style={style}
      data-glass-variant={variant}
      data-visual-owner="lens"
    >
      {children}
    </div>
  );
}
