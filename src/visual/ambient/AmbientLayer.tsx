import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DEFAULT_ACCENT } from "../../design/accent";
import { resolveAmbientPalette } from "../../design/ambient";
import type { AmbientPalette } from "../../design/ambientPresets";
import type { EffectsLevel } from "../../lib/launcher";
import { getLauncherWindow } from "../../lib/window";
import {
  createAmbientController,
  notifyAmbientStateChanged,
  setActiveAmbientController,
  type AmbientController,
  type AmbientTheme,
} from "./ambientController";
import "./ambient.css";

export interface AmbientLayerProps {
  enabled?: boolean;
  theme: AmbientTheme;
  palette?: AmbientPalette;
  accentSource?: string;
  accentColor?: string;
  intensity?: number;
  effects: EffectsLevel;
  reducedMotion?: boolean;
  highContrast?: boolean;
  customBackgroundActive?: boolean;
  /** Like the world, stop drawing while a game runs; the last frame stays. */
  gameRunning?: boolean;
}

export interface AmbientOverlayProps {
  visible: boolean;
  theme: AmbientTheme;
  palette?: AmbientPalette;
  accentSource?: string;
  accentColor?: string;
  intensity?: number;
  highContrast?: boolean;
}

function buildAmbientVars(palette: AmbientPalette, intensity: number): CSSProperties {
  return {
    "--ambient-color-0": palette[0],
    "--ambient-color-1": palette[1],
    "--ambient-color-2": palette[2],
    "--ambient-color-3": palette[3],
    "--ambient-intensity": String(intensity),
  } as CSSProperties;
}

export function AmbientLayer({
  enabled = true,
  theme,
  palette,
  accentSource = "voxelight",
  accentColor = DEFAULT_ACCENT,
  intensity = 0.6,
  effects,
  reducedMotion = false,
  highContrast = false,
  customBackgroundActive = false,
  gameRunning = false,
}: AmbientLayerProps) {
  const resolvedPalette =
    palette ?? resolveAmbientPalette({ accentSource, accentColor, theme });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<AmbientController | null>(null);
  const [hidden, setHidden] = useState(() =>
    typeof document !== "undefined" ? document.hidden : false,
  );
  const [minimized, setMinimized] = useState(false);

  const isCanvasMode = enabled && !highContrast && effects === "full" && !reducedMotion;
  const shouldPause =
    !isCanvasMode || customBackgroundActive || gameRunning || hidden || minimized;

  const latestRef = useRef({
    enabled,
    theme,
    palette: resolvedPalette,
    intensity,
    highContrast,
    reducedMotion,
    customBackgroundActive,
    isCanvasMode,
    shouldPause,
  });
  latestRef.current = {
    enabled,
    theme,
    palette: resolvedPalette,
    intensity,
    highContrast,
    reducedMotion,
    customBackgroundActive,
    isCanvasMode,
    shouldPause,
  };

  function syncController(controller: AmbientController) {
    const latest = latestRef.current;
    if (!latest.isCanvasMode) {
      // Detach first, so a config change never paints a canvas that is leaving.
      controller.stop();
      controller.attachCanvas(null);
    }
    controller.updateConfig({
      enabled: latest.enabled,
      theme: latest.theme,
      palette: latest.palette,
      intensity: latest.intensity,
      highContrast: latest.highContrast,
      reducedMotion: latest.reducedMotion,
      customBackgroundActive: latest.customBackgroundActive,
    });
    if (latest.isCanvasMode) {
      controller.attachCanvas(canvasRef.current);
      if (typeof window !== "undefined") {
        controller.resize(window.innerWidth, window.innerHeight);
      }
      controller.setPaused(latest.shouldPause);
      if (!latest.shouldPause) {
        controller.start();
      } else {
        controller.stop();
      }
    }
    notifyAmbientStateChanged();
  }

  useEffect(() => {
    const latest = latestRef.current;
    const controller = createAmbientController({
      enabled: latest.enabled,
      theme: latest.theme,
      palette: latest.palette,
      intensity: latest.intensity,
      highContrast: latest.highContrast,
      reducedMotion: latest.reducedMotion,
      customBackgroundActive: latest.customBackgroundActive,
      viewportWidth: typeof window !== "undefined" ? window.innerWidth : 1280,
      viewportHeight: typeof window !== "undefined" ? window.innerHeight : 720,
    });
    controllerRef.current = controller;
    setActiveAmbientController(controller);
    syncController(controller);

    const handleVisibility = () => {
      setHidden(document.hidden);
    };
    const handleResize = () => {
      controller.resize(window.innerWidth, window.innerHeight);
      notifyAmbientStateChanged();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("resize", handleResize);
    // The appearance provider writes data-theme after this layer's effects ran.
    // Re-read the --ambient-peak tokens once the attribute names the theme.
    const themeObserver = typeof MutationObserver === "function"
      ? new MutationObserver(() => {
          controller.updateConfig({});
          notifyAmbientStateChanged();
        })
      : null;
    themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    let active = true;
    const launcherWindow = getLauncherWindow();
    let unlistenPromise: Promise<() => void> | undefined;
    if (launcherWindow) {
      const checkMinimized = () => {
        void launcherWindow
          .isMinimized()
          .then((value) => {
            if (active) setMinimized(value);
          })
          .catch(() => {});
      };
      checkMinimized();
      unlistenPromise = launcherWindow.onResized(checkMinimized);
    }

    return () => {
      active = false;
      themeObserver?.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("resize", handleResize);
      if (unlistenPromise) {
        void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
      }
      setActiveAmbientController(null);
      controller.dispose();
      controllerRef.current = null;
      notifyAmbientStateChanged();
    };
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    syncController(controller);
  }, [
    enabled,
    theme,
    resolvedPalette[0],
    resolvedPalette[1],
    resolvedPalette[2],
    resolvedPalette[3],
    intensity,
    highContrast,
    reducedMotion,
    customBackgroundActive,
    isCanvasMode,
    shouldPause,
  ]);

  if (!enabled || highContrast) {
    return null;
  }

  if (isCanvasMode) {
    return (
      <div
        className="vx-ambient"
        data-ambient-mode="canvas"
        data-ambient-theme={theme}
        aria-hidden="true"
      >
        <canvas ref={canvasRef} className="vx-ambient-canvas" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div
      className="vx-ambient"
      data-ambient-mode="static"
      data-ambient-theme={theme}
      aria-hidden="true"
      style={buildAmbientVars(resolvedPalette, intensity)}
    >
      <div className="vx-ambient__static" />
    </div>
  );
}

export function AmbientOverlay({
  visible,
  theme,
  palette,
  accentSource = "voxelight",
  accentColor = DEFAULT_ACCENT,
  intensity = 0.6,
  highContrast = false,
}: AmbientOverlayProps) {
  if (!visible || highContrast) {
    return null;
  }
  const resolvedPalette =
    palette ?? resolveAmbientPalette({ accentSource, accentColor, theme });
  return (
    <div
      className="vx-ambient-overlay"
      data-ambient-overlay=""
      data-ambient-theme={theme}
      aria-hidden="true"
      style={buildAmbientVars(resolvedPalette, intensity)}
    />
  );
}
