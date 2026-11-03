// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { readStaticMotion, useLatticeStaticMotion } from "./staticMotion";

afterEach(() => { document.documentElement.removeAttribute("data-high-contrast"); vi.unstubAllGlobals(); });

it("keeps lattice fields still under the application high contrast preference", () => {
  document.documentElement.dataset.highContrast = "true";
  expect(readStaticMotion()).toBe(true);
});

it.each(["(prefers-contrast: more)", "(forced-colors: active)"])("reacts to live %s changes and releases its listener", async query => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const listeners = new Map<string, Set<() => void>>();
  let matched = false;
  vi.stubGlobal("matchMedia", (name: string) => ({
    get matches() { return name === query && matched; },
    addEventListener: (_: string, listener: () => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(listener); },
    removeEventListener: (_: string, listener: () => void) => listeners.get(name)?.delete(listener),
  }));
  function Probe() { return createElement("span", null, String(useLatticeStaticMotion())); }
  const host = document.createElement("div"); const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  expect(host.textContent).toBe("false");
  await act(async () => { matched = true; listeners.get(query)?.forEach(listener => listener()); });
  expect(host.textContent).toBe("true");
  await act(async () => root.unmount());
  expect([...listeners.values()].every(group => group.size === 0)).toBe(true);
});
