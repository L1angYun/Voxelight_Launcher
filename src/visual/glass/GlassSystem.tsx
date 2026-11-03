import {
  Fragment,
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
import { relativeRect, intersectRects, lensBoundaryPath, lensChromaticScales, type CurvatureGeometry } from "./geometry";
import { readGlassOptics } from "./optics";
import { curvatureMapImage } from "./refractionImage";
import { resetSurfaceOptics, syncSurfaceOptics } from "./liveOptics";
import { createGlassRenderer } from "./renderer";
import type { GlassMode, GlassOptics, GlassQuality, GlassRenderer, GlassSurfaceModel, GlassVariant } from "./types";
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
  syncOptics?: (optics?: GlassOptics) => void;
}

interface GlassContextValue {
  register: (id: string, surface: RegisteredSurface) => void;
  unregister: (id: string) => void;
  refractionEnabled: boolean;
}

const GlassContext = createContext<GlassContextValue | null>(null);

function LiquidRefractionDefs({ id, shape, image }: { id: string; shape: CurvatureGeometry; image: string }) {
  return (
    <svg
      className="vx-liquid-filter-defs"
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
    >
      <defs>
        <filter
          id={id}
          filterUnits="userSpaceOnUse"
          primitiveUnits="userSpaceOnUse"
          x="0"
          y="0"
          width={shape.width}
          height={shape.height}
          colorInterpolationFilters="sRGB"
        >
          <feImage data-vx-curvature href={image} x="0" y="0" width={shape.width} height={shape.height}
            preserveAspectRatio="none" result="curvature" />
          {lensChromaticScales(0, 0, shape.refraction, shape.dispersion).map((scale, channel) => <Fragment key={channel}>
            <feDisplacementMap data-vx-channel={channel} in="SourceGraphic" in2="curvature" scale={scale}
              xChannelSelector="R" yChannelSelector="G" result={`refracted-${channel}`} />
            <feColorMatrix in={`refracted-${channel}`} type="matrix" result={`channel-${channel}`}
              values={`${channel === 0 ? 1 : 0} 0 0 0 0  0 ${channel === 1 ? 1 : 0} 0 0 0  0 0 ${channel === 2 ? 1 : 0} 0 0  0 0 0 1 0`} />
          </Fragment>)}
          <feComposite in="channel-0" in2="channel-1" operator="arithmetic" k2="1" k3="1" result="redGreen" />
          <feComposite in="redGreen" in2="channel-2" operator="arithmetic" k2="1" k3="1" />
        </filter>
      </defs>
    </svg>
  );
}

function LensReflection({ id, shape }: { id: string; shape: CurvatureGeometry }) {
  const path = lensBoundaryPath(shape);
  return <svg className="vx-lens-reflection" viewBox={`0 0 ${shape.width} ${shape.height}`} aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-light`} data-vx-reflection x1="12%" y1="-8%" x2="88%" y2="108%">
        <stop offset="0" stopColor="white" stopOpacity="0.86" />
        <stop offset="0.27" stopColor="white" stopOpacity="0.3" />
        <stop offset="0.52" stopColor="white" stopOpacity="0" />
        <stop offset="0.82" stopColor="white" stopOpacity="0.04" />
        <stop offset="1" stopColor="white" stopOpacity="0.18" />
      </linearGradient>
      <filter id={`${id}-soft`} x="-15%" y="-15%" width="130%" height="130%"><feGaussianBlur stdDeviation="2.2" /></filter>
    </defs>
    <path data-vx-contour d={path} fill="none" stroke={`url(#${id}-light)`} strokeWidth="10"
      opacity="0.18" filter={`url(#${id}-soft)`} />
    <path data-vx-contour d={path} fill="none" stroke={`url(#${id}-light)`} strokeWidth="0.9" />
  </svg>;
}

export function GlassProvider({
  effects = "full",
  reducedMotion = false,
  reducedTransparency = false,
  highContrast = false,
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
    surface.syncOptics?.(optics);
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
    const renderer = createGlassRenderer(canvas, { onModeChange: setNativeMode, beforeFrame: syncLiveSurfaces, drawSurfaces: false });
    rendererRef.current = renderer;
    setNativeMode(renderer.mode);
    renderer.setQuality(effects);
    // Refraction is supplied by the browser's actual backdrop. The legacy
    // programmatic image prop must never masquerade as the live page behind it.
    renderer.setBackground(null);
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
    const poseObserver = new MutationObserver((records) => {
      // Only spring publishers request frames. The material's own clip, PNG and
      // reflection writes cannot recursively request another optical frame.
      if (records.some(({ target }) => target instanceof HTMLElement && target.style.getPropertyValue("--jelly-press") !== "")) updateFrame();
    });
    poseObserver.observe(root, { subtree: true, attributes: true, attributeFilter: ["style"] });
    return () => {
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      root.removeEventListener("pointermove", onPointer);
      root.removeEventListener("pointerleave", onPointerLeave);
      root.removeEventListener("scroll", syncPositions, true);
      themeObserver.disconnect();
      poseObserver.disconnect();
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

  const refractionEnabled = mode === "full" && effects === "full";
  const context = useMemo(() => ({ register, unregister, refractionEnabled }), [register, unregister, refractionEnabled]);

  return (
    <div
      ref={rootRef}
      className={cn("vx-glass-provider", className)}
      data-glass-mode={mode}
      data-glass-surface-count={surfaceCount}
      data-liquid-refraction="curvature"
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
  const [shape, setShape] = useState<CurvatureGeometry | null>(null);
  const shapeRef = useRef(shape);
  shapeRef.current = shape;
  const context = useContext(GlassContext);
  if (!context) throw new Error("GlassSurface must be used inside GlassProvider");
  const filterId = `vx-liquid-refraction-${generatedId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const image = useMemo(() => context.refractionEnabled && shape ? curvatureMapImage(shape) : null,
    [context.refractionEnabled, shape]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (image && shape) syncSurfaceOptics(element, shape, readGlassOptics(element));
    else resetSurfaceOptics(element);
    return () => resetSurfaceOptics(element);
  }, [image, shape]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element || !context.refractionEnabled) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      // offsetWidth/Height ignore the spring's transform. A moving control
      // reuses its map; only an actual layout resize regenerates this image.
      const width = element.offsetWidth || bounds.width;
      const height = element.offsetHeight || bounds.height;
      if (width <= 0 || height <= 0) return;
      const computed = getComputedStyle(element);
      const radius = Number.parseFloat(computed.borderTopLeftRadius) || presets[variant].radius;
      const bevel = Number.parseFloat(computed.getPropertyValue("--vx-lens-edge-width")) || 20;
      const refraction = Number.parseFloat(computed.getPropertyValue("--vx-lens-refraction")) || 0.9;
      const rawDispersion = Number.parseFloat(computed.getPropertyValue("--vx-lens-dispersion"));
      const dispersion = Number.isFinite(rawDispersion) ? rawDispersion : 0.65;
      setShape((previous) => previous?.width === width && previous.height === height && previous.radius === radius
        && previous.bevel === bevel && previous.refraction === refraction && previous.dispersion === dispersion
        ? previous : { width, height, radius, bevel, inset: 3, refraction, dispersion });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [context.refractionEnabled, variant]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const surface = { element, variant, active, syncOptics: (optics?: GlassOptics) => {
      if (context.refractionEnabled && shapeRef.current) syncSurfaceOptics(element, shapeRef.current, optics);
    } };
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
      style={{ ...style, "--vx-glass-refraction": image ? `url("#${filterId}")` : undefined } as CSSProperties}
      data-glass-variant={variant}
      data-visual-owner="lens"
      data-glass-refraction={image ? "curvature" : "none"}
    >
      {image && shape ? <LiquidRefractionDefs id={filterId} shape={shape} image={image} /> : null}
      {image && shape ? <LensReflection id={filterId} shape={shape} /> : null}
      {children}
    </div>
  );
}
