import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IdleAnimation, RunningAnimation, WalkingAnimation, SkinViewer as WebGLSkinViewer } from "skinview3d";
import type { BufferGeometry, Material, Object3D } from "three";
import { CapeTextureLoader, SkinTextureLoader, type SkinModel } from "../../components/skinTexture";
import { cn } from "../../lib/utils";
import "./character.css";

export type CharacterAnimation = "idle" | "walk" | "run" | "none";

function useReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    media.addListener?.(update);
    return () => {
      media.removeEventListener?.("change", update);
      media.removeListener?.(update);
    };
  }, []);
  return reduced;
}

export function CharacterCanvas({
  skinUrl,
  capeUrl,
  model = "auto",
  paused = false,
  interactive = false,
  autoRotate = interactive,
  animation = "idle",
  label,
  className,
  onError,
  retryLabel,
  errorLabel,
  resetToken = 0,
}: {
  skinUrl?: string | null;
  capeUrl?: string | null;
  model?: SkinModel;
  paused?: boolean;
  interactive?: boolean;
  autoRotate?: boolean;
  animation?: CharacterAnimation;
  label: string;
  className?: string;
  onError?: (message: string) => void;
  retryLabel?: string;
  errorLabel?: string;
  resetToken?: number;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<WebGLSkinViewer | null>(null);
  const loaderRef = useRef<SkinTextureLoader | null>(null);
  const capeLoaderRef = useRef<CapeTextureLoader | null>(null);
  const cameraTouched = useRef(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [viewer, setViewer] = useState<WebGLSkinViewer | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [capeError, setCapeError] = useState<string | null>(null);
  const [visible, setVisible] = useState(!document.hidden);
  const inView = useRef(true);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    canvasRef.current?.setAttribute("aria-label", label);
  }, [label]);

  useEffect(() => {
    const update = () => setVisible(!document.hidden && inView.current);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let active = true;
    let instance: WebGLSkinViewer;
    let observer: ResizeObserver | undefined;
    let intersectionObserver: IntersectionObserver | undefined;
    const canvas = document.createElement("canvas");
    canvasRef.current = canvas;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", label);
    canvas.tabIndex = interactive ? 0 : -1;
    mount.append(canvas);
    const reportFailure = (message: string) => {
      if (!active) return;
      setError(message);
      setLoading(false);
      onErrorRef.current?.(message);
    };
    try {
      instance = new WebGLSkinViewer({
        canvas,
        width: Math.max(1, mount.clientWidth),
        height: Math.max(1, mount.clientHeight),
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        zoom: 0.76,
        renderPaused: true,
      });
      instance.controls.enablePan = false;
      instance.controls.enableDamping = false;
      instance.controls.enableRotate = interactive;
      instance.controls.enableZoom = interactive;
      instance.controls.minDistance = 30;
      instance.controls.maxDistance = 140;
      instance.autoRotateSpeed = 0.32;
      instance.playerWrapper.rotation.y = -0.28;
      viewerRef.current = instance;
      loaderRef.current = new SkinTextureLoader(instance);
      capeLoaderRef.current = new CapeTextureLoader(instance);
      setError(null);
      setViewer(instance);
    } catch {
      canvas.remove();
      reportFailure("renderer.unavailable");
      return () => {
        active = false;
      };
    }

    const render = () => {
      if (active && !instance.disposed) instance.render();
    };
    const resize = () => {
      if (!active || instance.disposed) return;
      const { width, height } = mount.getBoundingClientRect();
      if (width < 1 || height < 1) return;
      instance.setSize(Math.round(width), Math.round(height));
      if (!cameraTouched.current) instance.zoom = Math.max(0.3, Math.min(0.76, width / height));
      render();
    };
    const touchCamera = () => {
      cameraTouched.current = true;
    };
    const release = () => canvas.dispatchEvent(new MouseEvent("mouseup"));
    const contextLost = (event: Event) => {
      event.preventDefault();
      reportFailure("renderer.unavailable");
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (!interactive || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-"].includes(event.key)) return;
      event.preventDefault();
      cameraTouched.current = true;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight")
        instance.playerWrapper.rotation.y += event.key === "ArrowLeft" ? -0.12 : 0.12;
      else if (event.key === "ArrowUp" || event.key === "ArrowDown")
        instance.playerWrapper.rotation.x = Math.max(
          -0.6,
          Math.min(0.6, instance.playerWrapper.rotation.x + (event.key === "ArrowUp" ? -0.08 : 0.08)),
        );
      else {
        const distance = instance.camera.position.length();
        const next = Math.max(30, Math.min(140, distance * (event.key === "-" ? 1.1 : 0.9)));
        instance.camera.position.multiplyScalar(next / distance);
        instance.controls.update();
      }
      render();
    };
    instance.controls.addEventListener("change", render);
    instance.controls.addEventListener("start", touchCamera);
    canvas.addEventListener("keydown", keydown);
    canvas.addEventListener("webglcontextlost", contextLost);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    window.addEventListener("resize", resize);
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(resize);
      observer.observe(mount);
    }
    inView.current = true;
    if (typeof IntersectionObserver !== "undefined") {
      intersectionObserver = new IntersectionObserver(([entry]) => {
        if (!active) return;
        inView.current = entry.isIntersecting;
        setVisible(!document.hidden && inView.current);
      }, { threshold: 0.01 });
      intersectionObserver.observe(mount);
    }
    resize();

    return () => {
      active = false;
      observer?.disconnect();
      intersectionObserver?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
      canvas.removeEventListener("keydown", keydown);
      canvas.removeEventListener("webglcontextlost", contextLost);
      instance.controls.removeEventListener("change", render);
      instance.controls.removeEventListener("start", touchCamera);
      loaderRef.current?.dispose();
      loaderRef.current = null;
      capeLoaderRef.current?.dispose();
      capeLoaderRef.current = null;
      viewerRef.current = null;
      const geometries = new Set<BufferGeometry>();
      const materials = new Set<Material>();
      instance.scene.traverse((object: Object3D) => {
        const mesh = object as typeof object & { geometry?: BufferGeometry; material?: Material | Material[] };
        if (mesh.geometry) geometries.add(mesh.geometry);
        if (mesh.material)
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
      });
      instance.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      instance.composer.dispose();
      instance.fxaaPass.material.dispose();
      instance.renderer.forceContextLoss();
      canvas.remove();
      canvasRef.current = null;
    };
  }, [attempt, interactive, label]);

  useEffect(() => {
    if (!viewer || viewer.disposed) return;
    let active = true;
    setLoading(true);
    setError(null);
    viewer.playerWrapper.visible = false;
    viewer.render();
    if (!skinUrl) {
      setLoading(false);
      return;
    }
    void loaderRef.current?.load(skinUrl, model).then((applied) => {
      if (!active || viewer.disposed) return;
      if (applied) {
        viewer.playerWrapper.visible = true;
        viewer.render();
      }
      setLoading(false);
    }).catch((cause: unknown) => {
      if (!active) return;
      const message = cause instanceof Error ? cause.message : "skin.loadFailed";
      setError(message);
      setLoading(false);
      onErrorRef.current?.(message);
    });
    return () => {
      active = false;
    };
  }, [viewer, skinUrl, model]);

  useEffect(() => {
    if (!viewer || viewer.disposed) return;
    let active = true;
    setCapeError(null);
    void capeLoaderRef.current?.load(null, "cape").then(() => {
      if (!active || viewer.disposed || !capeUrl) return null;
      return capeLoaderRef.current?.load(capeUrl, "cape");
    }).then((applied) => {
      if (active && applied && !viewer.disposed) viewer.render();
    }).catch((cause: unknown) => {
      if (!active) return;
      const message = cause instanceof Error ? cause.message : "cape.loadFailed";
      setCapeError(message);
      onErrorRef.current?.(message);
    });
    return () => {
      active = false;
    };
  }, [viewer, capeUrl]);

  useEffect(() => {
    if (!viewer || viewer.disposed) return;
    const mode = reducedMotion ? "none" : animation;
    viewer.animation = mode === "walk" ? new WalkingAnimation() : mode === "run" ? new RunningAnimation() : mode === "idle" ? new IdleAnimation() : null;
    viewer.autoRotate = autoRotate && interactive && !reducedMotion;
    viewer.renderPaused = paused || !visible || (mode === "none" && !viewer.autoRotate);
    if (!viewer.renderPaused) viewer.render();
  }, [viewer, animation, autoRotate, interactive, paused, reducedMotion, visible]);

  useEffect(() => {
    if (!resetToken || !viewer || viewer.disposed) return;
    cameraTouched.current = false;
    viewer.playerWrapper.rotation.set(0, -0.28, 0);
    const mount = mountRef.current;
    viewer.zoom = Math.max(0.3, Math.min(0.76, (mount?.clientWidth || 300) / (mount?.clientHeight || 400)));
    viewer.resetCameraPose();
    viewer.controls.update();
    viewer.render();
  }, [resetToken, viewer]);

  return (
    <div
      className={cn("vx-character-canvas", className)}
      data-character-state={error || capeError ? "error" : loading ? "loading" : "ready"}
      data-skin-url={skinUrl ?? ""}
      data-skin-model={model}
      data-cape-url={capeUrl ?? ""}
      data-visible={visible}
    >
      <div className="vx-character-canvas__mount" ref={mountRef} aria-busy={loading} />
      {error || capeError ? (
        <div className="vx-character-canvas__error" role="alert">
          <span>{errorLabel ?? (error === "renderer.unavailable" ? t("shell:errors.renderer.unavailable") : error ? t("shell:errors.skin.loadFailed") : capeError ? t("shell:errors.cape.loadFailed") : t("shell:errors.renderer.unavailable"))}</span>
          <button type="button" data-character-retry onClick={() => setAttempt((value) => value + 1)}>
            {retryLabel ?? t("common:actions.retry")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
