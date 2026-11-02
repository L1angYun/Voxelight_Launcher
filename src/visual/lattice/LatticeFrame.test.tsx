// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLauncherI18n } from "../../i18n";
import type { Instance, ResourceProject } from "../../lib/launcher";
import { InstanceCard } from "../../features/library/InstanceCard";
import { ProjectCard } from "../../features/discover/ProjectCard";
import { RecentInstances } from "../../features/home/RecentInstances";
import { LatticeFrame } from "./LatticeFrame";

let root: Root;
let container: HTMLDivElement;
let scheduled: FrameRequestCallback[];

function render(node: ReactNode) {
  act(() => root.render(node));
}

async function renderCard(node: ReactNode) {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  render(createElement(I18nextProvider, { i18n }, node));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  scheduled = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    scheduled.push(callback);
    return scheduled.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  document.documentElement.dataset.effects = "full";
  document.documentElement.dataset.reducedMotion = "false";
  document.documentElement.dataset.cursorHalo = "true";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete document.documentElement.dataset.effects;
  delete document.documentElement.dataset.reducedMotion;
  delete document.documentElement.dataset.cursorHalo;
  vi.unstubAllGlobals();
});

describe("card interaction markers", () => {
  it.each([
    ["selected", { selected: true }],
    ["hovered", { hovered: true }],
    ["keyboard focused", { focused: true }],
  ] as const)("does not create an independent particle pool for a %s card", (_state, props) => {
    render(createElement(LatticeFrame, { ...props, signature: "alpha" }));
    expect(container.querySelectorAll(".vx-lattice-frame__dot,canvas")).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  it("leaves no local dispersing particles after the shared points leave a card", () => {
    render(createElement(LatticeFrame, { hovered: true, signature: "alpha" }));
    render(createElement(LatticeFrame, { hovered: false, signature: "alpha" }));
    expect(container.querySelector(".is-dispersing")).toBeNull();
    expect(container.querySelectorAll(".vx-lattice-frame__dot,canvas")).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  it("keeps a direct static frame for target discovery and keyboard fallback", () => {
    delete document.documentElement.dataset.cursorHalo;
    render(createElement("article", { "data-visual-owner": "lattice" },
      createElement(LatticeFrame, { selected: true, focused: true, signature: "alpha" }),
      createElement("button", null, "Open")));
    const frame = container.querySelector<HTMLElement>("article > .vx-lattice-frame")!;
    expect(frame.dataset.focused).toBe("true");
    expect(frame.dataset.selected).toBe("true");
    expect(frame.dataset.signature).toBe("alpha");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
  });
});

const instance: Instance = {
  id: "alpha", name: "Alpha", versionId: "1.21.1", gameDirectory: "C:\\Fixture\\Alpha",
  createdAt: "2026-11-01T00:00:00Z", category: "", notes: "", totalPlayTime: 0,
  loader: "vanilla", loaderVersion: "",
};
const project: ResourceProject = {
  project_id: "sodium", slug: "sodium", title: "Sodium", description: "Rendering optimization",
  icon_url: null, downloads: 1200, author: "Author", project_type: "mod", versions: ["1.21.1"],
};
const recipes = [
  ["instance", (selected: boolean) => createElement(InstanceCard, { instance, selected, onOpen: vi.fn(), onLaunch: vi.fn() })],
  ["project", (selected: boolean) => createElement(ProjectCard, { project, selected, targetName: "Alpha", onOpen: vi.fn(), onInstall: vi.fn() })],
  ["recent instance", (selected: boolean) => createElement(RecentInstances, { instances: [instance], selectedId: selected ? "alpha" : undefined, onSelect: vi.fn() })],
] as const;

describe("persistent card selection", () => {
  it.each(recipes)("keeps one non-color selection mark outside the owned frame on a %s card", async (_name, card) => {
    await renderCard(card(true));
    const surface = container.querySelector<HTMLElement>("[data-visual-owner='lattice']")!;
    const marker = surface.querySelector("svg[data-selected-mark]");
    expect(marker).not.toBeNull();
    expect(surface.querySelectorAll("svg[data-selected-mark]")).toHaveLength(1);
    expect(surface.querySelector(":scope > .vx-lattice-frame")!.contains(marker)).toBe(false);
    await renderCard(card(false));
    expect(container.querySelector("svg[data-selected-mark]")).toBeNull();
  });
});
