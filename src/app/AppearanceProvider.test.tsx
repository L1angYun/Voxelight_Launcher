// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceProvider, resolveEffects, useAppearance } from "./AppearanceProvider";
import { defaults, type Config, type SystemAppearance } from "../lib/launcher";
import type { AppearanceContextValue } from "./AppearanceProvider";

let root: Root;
let container: HTMLDivElement;
let current: AppearanceContextValue;
let mediaMatches: Record<string, boolean>;

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

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mediaMatches = { "(prefers-color-scheme: light)": true };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: Boolean(mediaMatches[query]),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
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
