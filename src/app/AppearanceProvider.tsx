import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Config, EffectsLevel, SystemAppearance } from "../lib/launcher";
import { buildAccentScale, type AccentScale } from "../design/accent";

export const defaultSystemAppearance: SystemAppearance = {
  accentColor: "#b4f17a",
  animationsEnabled: true,
  advancedEffectsEnabled: true,
  locale: "en-US",
};

export interface ResolvedEffects {
  ambientMotion: boolean;
  glassMotion: boolean;
  transparency: boolean;
}

export function resolveEffects({
  effects,
  reducedMotion = false,
  reducedTransparency = false,
  highContrast = false,
}: {
  effects: EffectsLevel;
  reducedMotion?: boolean;
  reducedTransparency?: boolean;
  highContrast?: boolean;
}): ResolvedEffects {
  const transparency = !reducedTransparency && !highContrast;
  const ambientMotion = effects === "full" && !reducedMotion;
  return {
    ambientMotion,
    glassMotion: ambientMotion && transparency,
    transparency,
  };
}

export interface AppearanceContextValue {
  resolvedTheme: "dark" | "light";
  effects: EffectsLevel;
  accent: Config["accentSource"];
  accentColor: string;
  accentScale: AccentScale;
  reducedMotion: boolean;
  reducedTransparency: boolean;
  highContrast: boolean;
  systemAppearance: SystemAppearance;
  systemLocale: string;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.("change", update);
    media.addListener?.(update);
    return () => {
      media.removeEventListener?.("change", update);
      media.removeListener?.(update);
    };
  }, [query]);
  return matches;
}

export function AppearanceProvider({
  config,
  systemAppearance = defaultSystemAppearance,
  children,
}: {
  config: Config;
  systemAppearance?: SystemAppearance;
  children?: ReactNode;
}) {
  const systemLight = useMedia("(prefers-color-scheme: light)");
  const reducedMotionMedia = useMedia("(prefers-reduced-motion: reduce)");
  const reducedTransparencyMedia = useMedia("(prefers-reduced-transparency: reduce)");
  const forcedColors = useMedia("(forced-colors: active)");
  const moreContrast = useMedia("(prefers-contrast: more)");
  const resolvedTheme = config.theme === "system" ? (systemLight ? "light" : "dark") : config.theme;
  const reducedMotion = reducedMotionMedia || !systemAppearance.animationsEnabled;
  const reducedTransparency =
    reducedTransparencyMedia || !systemAppearance.advancedEffectsEnabled;
  const highContrast = forcedColors || moreContrast;
  const accentColor =
    config.accentSource === "system"
      ? systemAppearance.accentColor
      : config.accentSource === "custom"
        ? config.accentColor
        : "#b4f17a";
  const accentScale = useMemo(
    () => buildAccentScale(accentColor, resolvedTheme),
    [accentColor, resolvedTheme],
  );
  const value: AppearanceContextValue = {
    resolvedTheme,
    effects: config.effects,
    accent: config.accentSource,
    accentColor,
    accentScale,
    reducedMotion,
    reducedTransparency,
    highContrast,
    systemAppearance,
    systemLocale: systemAppearance.locale,
  };

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.effects = config.effects;
    root.dataset.reducedMotion = String(reducedMotion);
    root.dataset.reducedTransparency = String(reducedTransparency);
    root.dataset.highContrast = String(highContrast);
    root.dataset.accentSource = config.accentSource;
    root.style.setProperty("--accent", accentScale.base);
    root.style.setProperty("--accent-hover", accentScale.hover);
    root.style.setProperty("--accent-active", accentScale.active);
    root.style.setProperty("--accent-soft", accentScale.soft);
    root.style.setProperty("--accent-border", accentScale.border);
    root.style.setProperty("--accent-foreground", accentScale.foreground);
  }, [accentScale, config.accentSource, config.effects, highContrast, reducedMotion, reducedTransparency, resolvedTheme]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance must be used inside AppearanceProvider");
  return value;
}
