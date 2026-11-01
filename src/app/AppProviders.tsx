import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { command, events, type SystemAppearance } from "../lib/launcher";
import { createLauncherI18n } from "../i18n";
import { LauncherProvider, useLauncher } from "./controller/LauncherProvider";
import { AppearanceProvider, defaultSystemAppearance, useAppearance } from "./AppearanceProvider";
import { OvertureProvider } from "../visual/overture/OvertureProvider";
import { GlassProvider } from "../visual/glass/GlassSystem";
import { paintVoxelBackdrop } from "../visual/glass/backdrop";
import { mountCursorHalo } from "../visual/lattice/cursor";

function useSystemAppearance(): SystemAppearance {
  const [system, setSystem] = useState(defaultSystemAppearance);
  useEffect(() => {
    let active = true;
    void command<SystemAppearance>("get_system_appearance")
      .then((value) => {
        if (active && value) setSystem(value);
      })
      .catch(() => {});
    const disposer = events<SystemAppearance>("launcher://system-appearance", (value) => {
      if (active && value) setSystem(value);
    });
    return () => {
      active = false;
      void disposer.then((dispose) => dispose());
    };
  }, []);
  return system;
}

// The glass refracts one procedural landscape. It is repainted only when the resolved theme or accent actually changes.
function useGlassBackdrop(): HTMLCanvasElement | null {
  const [backdrop, setBackdrop] = useState<HTMLCanvasElement | null>(null);
  const painted = useRef("");
  useEffect(() => {
    const root = document.documentElement;
    const repaint = () => {
      const light = root.dataset.theme === "light";
      const accent = getComputedStyle(root).getPropertyValue("--accent").trim();
      const key = `${light}|${accent}`;
      if (key === painted.current) return;
      painted.current = key;
      setBackdrop(paintVoxelBackdrop({ light, accent }));
    };
    repaint();
    const observer = new MutationObserver(repaint);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => observer.disconnect();
  }, []);
  return backdrop;
}

export function useCursorHalo(effects: string, reducedMotion: boolean, highContrast = false) {
  const haloRef = useRef<ReturnType<typeof mountCursorHalo>>(null);

  useEffect(() => {
    const root = document.documentElement;
    const fine = typeof window.matchMedia === "function"
      ? window.matchMedia("(any-pointer: fine)") : null;
    const dispose = () => {
      haloRef.current?.dispose();
      haloRef.current = null;
      delete root.dataset.cursorHalo;
    };
    const sync = () => {
      if (effects !== "full" || reducedMotion || highContrast || !fine?.matches) {
        dispose();
        return;
      }
      if (haloRef.current) return;
      const halo = mountCursorHalo(root);
      if (!halo) return;
      haloRef.current = halo;
      root.dataset.cursorHalo = "true";
    };
    sync();
    fine?.addEventListener?.("change", sync);
    return () => {
      fine?.removeEventListener?.("change", sync);
      dispose();
    };
  }, [effects, reducedMotion, highContrast]);
}

function VisualProviders({ children }: { children?: ReactNode }) {
  const { config } = useLauncher();
  const glassBackdrop = useGlassBackdrop();
  const { effects, reducedMotion, reducedTransparency, highContrast, systemLocale } = useAppearance();
  useCursorHalo(effects, reducedMotion, highContrast);
  const pseudoLocale = import.meta.env.DEV && new URLSearchParams(window.location.search).has("stress-locale");
  const i18n = useMemo(
    () => createLauncherI18n(config.language, systemLocale, pseudoLocale),
    [config.language, systemLocale, pseudoLocale],
  );
  return (
    <I18nextProvider i18n={i18n}>
      <OvertureProvider reducedMotion={reducedMotion} soundEnabled={config.soundEnabled}>
        <GlassProvider
          effects={effects}
          reducedMotion={reducedMotion}
          reducedTransparency={reducedTransparency}
          highContrast={highContrast}
          background={glassBackdrop}
          className="vx-app"
        >
          {children}
        </GlassProvider>
      </OvertureProvider>
    </I18nextProvider>
  );
}

function AppearanceBridge({ children }: { children?: ReactNode }) {
  const { config } = useLauncher();
  const systemAppearance = useSystemAppearance();
  return (
    <AppearanceProvider config={config} systemAppearance={systemAppearance}>
      <VisualProviders>{children}</VisualProviders>
    </AppearanceProvider>
  );
}

export function AppProviders({ children }: { children?: ReactNode }) {
  return (
    <LauncherProvider>
      <AppearanceBridge>{children}</AppearanceBridge>
    </LauncherProvider>
  );
}
