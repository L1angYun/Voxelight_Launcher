// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceProvider, resolveEffects, useAppearance } from "./AppearanceProvider";
import { defaults, type Config, type SystemAppearance } from "../lib/launcher";
import type { AppearanceContextValue } from "./AppearanceProvider";
import { buildAccentScale, contrast, DEFAULT_ACCENT } from "../design/accent";

let root: Root;
let container: HTMLDivElement;
let current: AppearanceContextValue;
let mediaMatches: Record<string, boolean>;
let mediaListeners: Map<string, Set<() => void>>;

function Harness() {
  current = useAppearance();
  return null;
}

function render(config: Config, system: SystemAppearance) {
  act(() => {
    root.render(
      createElement(
        AppearanceProvider,
        { config, systemAppearance: system },
        createElement(Harness),
      ),
    );
  });
}

function setSystemLight(light: boolean) {
  act(() => {
    mediaMatches["(prefers-color-scheme: light)"] = light;
    mediaListeners.get("(prefers-color-scheme: light)")?.forEach((listener) => listener());
  });
}

const systemAppearance: SystemAppearance = {
  accentColor: "#123456",
  animationsEnabled: true,
  advancedEffectsEnabled: true,
  locale: "en-US",
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mediaMatches = { "(prefers-color-scheme: light)": true };
  mediaListeners = new Map();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => {
      if (!mediaListeners.has(query)) mediaListeners.set(query, new Set());
      return {
        get matches() { return Boolean(mediaMatches[query]); },
        media: query,
        addEventListener: (_event: string, listener: () => void) => mediaListeners.get(query)!.add(listener),
        removeEventListener: (_event: string, listener: () => void) => mediaListeners.get(query)!.delete(listener),
        addListener: (listener: () => void) => mediaListeners.get(query)!.add(listener),
        removeListener: (listener: () => void) => mediaListeners.get(query)!.delete(listener),
      };
    }),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  current = undefined as unknown as AppearanceContextValue;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("appearance and accessibility preferences", () => {
  it("publishes a contrast-safe light indicator and restores the base indicator with the system theme", () => {
    render({ ...defaults, theme: "system", accentSource: "system" }, { ...systemAppearance, accentColor: DEFAULT_ACCENT });
    const style = document.documentElement.style;
    const lightIndicator = style.getPropertyValue("--accent-indicator");
    expect(lightIndicator).toMatch(/^#[0-9a-f]{6}$/);
    expect(style.getPropertyValue("--accent")).toBe(buildAccentScale(DEFAULT_ACCENT, "light").base);
    for (const surface of ["#f3f1eb", "#fcfaf6", "#ffffff"])
      expect(contrast(lightIndicator, surface)).toBeGreaterThanOrEqual(3);
    setSystemLight(false);
    expect(style.getPropertyValue("--accent-indicator")).toMatch(/^#[0-9a-f]{6}$/);
    for (const surface of ["#07080b", "#0e1013", "#131417", "#232528", "#2f3033"])
      expect(contrast(style.getPropertyValue("--accent-indicator"), surface)).toBeGreaterThanOrEqual(3);
    setSystemLight(true);
    expect(style.getPropertyValue("--accent-indicator")).toBe(lightIndicator);
  });

  it("keeps the primary fill and foreground readable and leaves soft/border to CSS", () => {
    render({ ...defaults, theme: "dark", accentSource: "system" }, systemAppearance);
    const style = document.documentElement.style;
    const foreground = style.getPropertyValue("--accent-foreground");
    for (const role of ["--accent", "--accent-hover", "--accent-active"])
      expect(contrast(style.getPropertyValue(role), foreground), role).toBeGreaterThanOrEqual(4.5);
    expect(style.getPropertyValue("--accent-soft")).toBe("");
    expect(style.getPropertyValue("--accent-border")).toBe("");
  });

  it("falls back to Windows' default blue when the system accent is unavailable", () => {
    render({ ...defaults, accentSource: "system", accentColor: "#123456" }, { ...systemAppearance, accentColor: "" });
    expect(current.accentColor).toBe(DEFAULT_ACCENT);
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(buildAccentScale(DEFAULT_ACCENT, "light").base);
  });

  it("resolves the retired voxelight source through the system accent instead of the old green", () => {
    render({ ...defaults, accentSource: "voxelight", accentColor: "#123457" }, { ...systemAppearance, accentColor: "#123456" });
    expect(current.accentColor).toBe("#123456");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  });

  it("follows the current system theme with an untouched default configuration", () => {
    render({ ...defaults }, systemAppearance);
    expect(current.resolvedTheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    setSystemLight(false);
    expect(current.resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("updates a system theme in both directions without remounting", () => {
    render({ ...defaults, theme: "system" }, systemAppearance);
    setSystemLight(false);
    expect(current.resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    setSystemLight(true);
    expect(current.resolvedTheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it.each(["dark", "light"] as const)("preserves an explicit %s preference when the system changes", (theme) => {
    render({ ...defaults, theme }, systemAppearance);
    setSystemLight(false);
    expect(current.resolvedTheme).toBe(theme);
    expect(document.documentElement.dataset.theme).toBe(theme);
    setSystemLight(true);
    expect(current.resolvedTheme).toBe(theme);
    expect(document.documentElement.dataset.theme).toBe(theme);
  });

  it("gives reduced motion and transparency priority over full effects", () => {
    expect(resolveEffects({ effects: "full", reducedMotion: true }).ambientMotion).toBe(false);
    expect(resolveEffects({ effects: "full", reducedTransparency: true }).transparency).toBe(false);
    expect(resolveEffects({ effects: "lite", reducedMotion: false }).ambientMotion).toBe(false);
    expect(resolveEffects({ effects: "full", reducedMotion: false }).ambientMotion).toBe(true);
  });

  it("resolves system theme, system accent, and native accessibility flags", () => {
    const config: Config = {
      ...defaults,
      theme: "system",
      accentSource: "system",
      effects: "full",
    };
    render(config, {
      accentColor: "#123456",
      animationsEnabled: false,
      advancedEffectsEnabled: false,
      locale: "en-US",
    });
    expect(current.resolvedTheme).toBe("light");
    expect(current.accent).toBe("system");
    expect(current.accentColor).toBe("#123456");
    expect(current.reducedMotion).toBe(true);
    expect(current.reducedTransparency).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
