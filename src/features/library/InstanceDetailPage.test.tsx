// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLauncherI18n } from "../../i18n";
import { command, defaults, type Instance } from "../../lib/launcher";
import { InstanceDetailPage } from "./InstanceDetailPage";

const read = (name: string) => readFileSync(join(process.cwd(), "src/features/library", name), "utf8");
const detailCss = read("instance-detail.css");
const logCss = read("game-log.css");
const rule = (css: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s,}])${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css)?.[1] ?? "";
};

const commandMock = vi.mocked(command);
let root: Root;
let container: HTMLDivElement;

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  desktop: true,
}));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => ({ run: async (_key: string, task: () => Promise<unknown>) => task(), config: defaults, logs: [], running: [], busy: "" }),
}));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false }),
}));
vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children, className }: { children: ReactNode; className?: string }) => createElement("div", { className }, children),
}));

const instance: Instance = {
  id: "fixture", name: "Fixture", versionId: "1.21.1", gameDirectory: "C:\\SyntheticFixture\\fixture",
  createdAt: "2026-10-25T08:00:00Z", category: "", notes: "", totalPlayTime: 0, loader: "fabric", loaderVersion: "0.16.9",
  kind: "version", isolated: true,
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  commandMock.mockReset();
  commandMock.mockImplementation(async (name) => name === "list_instance_backups" ? { backups: [], warnings: [], recovery: null } : null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("instance detail styles", () => {
  it("draws info cells and screenshot tiles as sunken wells without a feature colour mix", () => {
    for (const selector of [".vx-facts > div", ".vx-screenshot"]) {
      expect(rule(detailCss, selector)).toMatch(/background:\s*var\(--surface-sunken\);/);
      expect(rule(detailCss, selector)).toMatch(/box-shadow:\s*var\(--edge-shade\);/);
    }
    expect(detailCss).not.toMatch(/color-mix\(/);
    expect(logCss).not.toMatch(/color-mix\(/);
  });

  it("gives the resource search 280px and the kind select a 200 to 260px range", () => {
    expect(rule(detailCss, ".vx-resource-search")).toMatch(/flex:\s*1 1 280px;/);
    const kind = rule(detailCss, ".vx-toolbar > .vx-resource-kind-select");
    expect(kind).toMatch(/flex:\s*0 1 auto;/);
    expect(kind).toMatch(/min-width:\s*var\(--field-width-md\);/);
    expect(kind).toMatch(/max-width:\s*260px;/);
  });

  it("uses the R9 tokens instead of the stage-1 aliases", () => {
    const aliases = /var\(--(?:hairline|surface-hover|surface-solid|bg-base|text-xs|text-sm|text-2xl|shadow-raised|vx-lens-radius-menu)[,)]/;
    expect(detailCss).not.toMatch(aliases);
    expect(logCss).not.toMatch(aliases);
    expect(rule(detailCss, ".vx-detail-manage__menu.vx-glass-surface")).toMatch(/border-radius:\s*var\(--radius-xl\);/);
    expect(rule(logCss, ".vx-game-log__line")).toMatch(/font:\s*var\(--type-code\);/);
    expect(rule(detailCss, ".vx-log-view")).toMatch(/font:\s*var\(--type-code\);/);
  });

  it("styles section titles without overriding an inline empty state's quieter title", () => {
    expect(detailCss).not.toMatch(/\.vx-detail-section h2\s*[,{]/);
    expect(detailCss).toMatch(/\.vx-detail-section > h2, \.vx-detail-section > \.vx-section-heading > h2\s*\{[^}]*font:\s*var\(--type-section\);/);
  });

  it("styles section prose without overriding an inline empty state's quieter description", () => {
    expect(detailCss).not.toMatch(/\.vx-detail-section (?:p|li)\s*[,{]/);
    const prose = /\.vx-detail-section p:not\(\.vx-empty p\),\s*\.vx-detail-section li:not\(\.vx-empty li\)\s*\{([^}]*)\}/.exec(detailCss)?.[1] ?? "";
    expect(prose).toMatch(/color:\s*var\(--text-secondary\);/);
    const empty = document.createElement("section");
    empty.className = "vx-detail-section";
    empty.innerHTML = '<p data-prose></p><section class="vx-empty vx-empty--inline"><h2></h2><p data-empty></p></section>';
    expect(empty.querySelector("[data-prose]")!.matches(".vx-detail-section p:not(.vx-empty p)")).toBe(true);
    expect(empty.querySelector("[data-empty]")!.matches(".vx-detail-section p:not(.vx-empty p)")).toBe(false);
  });

  it("keeps the save bar sticky at the bottom of the settings form", () => {
    const bar = rule(detailCss, ".vx-detail-savebar");
    expect(bar).toMatch(/position:\s*sticky;/);
    expect(bar).toMatch(/bottom:\s*0;/);
    expect(bar).toMatch(/justify-content:\s*flex-end;/);
  });
});

describe("library grid styles", () => {
  it("leaves the hover-only card chevron out of the drill-return reveal", () => {
    const gridCss = read("library-grid.css");
    // The reveal animates opacity 0 to 1 without a fill; the chevron rests at 0,
    // so revealing it would flash every card's chevron after leaving a detail.
    expect(gridCss).toMatch(/\n\s*\.vx-instance-card__open \{[^}]*opacity:\s*0;/);
    const reveal = /\.vx-library-page\[data-drill-return\] :is\(([^)]*)\)\s*\{[^}]*vx-library-content-reveal/.exec(gridCss)?.[1] ?? "";
    expect(reveal).toContain(".vx-instance-card__information");
    expect(reveal).not.toContain(".vx-instance-card__open");
  });
});

describe("instance detail page", () => {
  it("draws the header icons from the icon scale", async () => {
    const i18n = createLauncherI18n("en-US", "en-US");
    await i18n.initPromise;
    await act(async () => root.render(createElement(I18nextProvider, { i18n },
      createElement(InstanceDetailPage, { instance, onBack: vi.fn(), onChanged: vi.fn(async () => {}), onLaunch: vi.fn() }))));
    const sizes = [...container.querySelectorAll<SVGElement>(".vx-detail-header svg.lucide, .vx-detail-context svg.lucide")]
      .map((icon) => Number(icon.getAttribute("width")));
    expect(sizes.length).toBeGreaterThan(5);
    expect(sizes.every((size) => size === 16)).toBe(true);
  });
});
