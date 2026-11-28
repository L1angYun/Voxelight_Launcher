// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLauncherI18n } from "../../i18n";
import { command } from "../../lib/launcher";
import type { LocalResource } from "./types";
import { InstanceContent } from "./InstanceContent";

const css = readFileSync(join(process.cwd(), "src/features/library/instance-detail.css"), "utf8");
const commandMock = vi.mocked(command);
let root: Root;
let container: HTMLDivElement;

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  desktop: true,
}));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false }),
}));
vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children, className }: { children: ReactNode; className?: string }) => createElement("div", { className }, children),
}));

const file = (name: string, enabled = true): LocalResource =>
  ({ name, fileName: `${name.toLowerCase()}.zip${enabled ? "" : ".disabled"}`, path: `resourcepacks/${name}.zip`, size: 2048, enabled });

let files: LocalResource[];

async function render() {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(InstanceContent, { versionId: "1.21.1", instanceId: "fixture" }))));
}

const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
const calls = (name: string) => commandMock.mock.calls.filter(([command]) => command === name);

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  files = [file("Alpha"), file("Beta", false), file("Gamma")];
  commandMock.mockReset();
  commandMock.mockImplementation(async (name, args) => {
    if (name === "list_local_resources") return files;
    if (name === "list_resource_update_history") return [];
    if (name === "toggle_resource") {
      files = files.map((item) => item.fileName === args?.fileName ? { ...item, enabled: !item.enabled } : item);
      return null;
    }
    return null;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("instance content", () => {
  it("shows each file's state as a switch that names the state and toggles it", async () => {
    await render();
    const switches = [...container.querySelectorAll<HTMLButtonElement>('.vx-resource-file-row [role="switch"]')];
    expect(switches.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false", "true"]);
    expect(switches.map((item) => item.textContent)).toEqual(["Enabled", "Disabled", "Enabled"]);
    expect(switches.every((item) => !item.hasAttribute("aria-pressed"))).toBe(true);
    expect(switches[1].querySelector(".vx-switch__track")?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => switches[1].click());
    expect(calls("toggle_resource").at(-1)?.[1]).toMatchObject({ fileName: "beta.zip.disabled" });
    expect(container.querySelectorAll('[role="switch"][aria-checked="true"]')).toHaveLength(3);
    expect(css).toMatch(/\.vx-switch__track\s*\{[^}]*width:\s*28px;[^}]*height:\s*16px/);
  });

  it("labels select-all with the visible count and heads the state column", async () => {
    await render();
    const header = container.querySelector<HTMLElement>(".vx-resource-list__header")!;
    const checkbox = header.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const label = header.querySelector<HTMLLabelElement>("label")!;
    expect(label.textContent).toBe("Select all (3)");
    expect(label.htmlFor).toBe(checkbox.id);
    expect(label.contains(checkbox)).toBe(false);
    expect(checkbox.hasAttribute("aria-label")).toBe(false);
    expect(header.lastElementChild?.textContent).toBe("Status");
  });

  it("hides the batch actions behind a hint until a file is selected", async () => {
    await render();
    const bar = container.querySelector<HTMLElement>(".vx-resource-batch")!;
    expect(bar.dataset.empty).toBe("true");
    expect(bar.querySelector('[role="status"]')?.textContent).toBe("Select files to change several at once");
    expect(bar.querySelector(".vx-resource-batch__actions")?.getAttribute("aria-hidden")).toBe("true");
    expect(css).toMatch(/\.vx-resource-batch\[data-empty="true"\] \.vx-resource-batch__actions\s*\{\s*visibility:\s*hidden;/);
    await act(async () => container.querySelector<HTMLInputElement>('.vx-resource-file-row input[type="checkbox"]')!.click());
    expect(bar.dataset.empty).toBe("false");
    expect(bar.querySelector('[role="status"]')?.textContent).toBe("1 file selected");
    expect(bar.querySelector(".vx-resource-batch__actions")?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("loads update history from its tab instead of a duplicate toolbar button", async () => {
    await render();
    expect([...container.querySelectorAll(".vx-toolbar button")].some((item) => item.textContent === "Update history")).toBe(false);
    const historyTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Update history")!;
    await act(async () => historyTab.click());
    expect(calls("list_resource_update_history")).toHaveLength(1);
    expect(historyTab.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".vx-empty--inline h2")?.textContent).toBe("No update history");
  });

  it("loads the history picked while the files are still loading once that load ends", async () => {
    let finish: (value: LocalResource[]) => void = () => {};
    commandMock.mockImplementation(async (name) => {
      if (name === "list_local_resources") return new Promise<LocalResource[]>((resolve) => { finish = resolve; });
      if (name === "list_resource_update_history") return [];
      return null;
    });
    await render();
    const historyTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Update history")!;
    await act(async () => historyTab.click());
    expect(historyTab.getAttribute("aria-selected")).toBe("true");
    expect(calls("list_resource_update_history")).toHaveLength(0);
    await act(async () => finish(files));
    expect(calls("list_resource_update_history")).toHaveLength(1);
    expect(container.querySelector(".vx-empty--inline h2")?.textContent).toBe("No update history");
    // Once loaded, later work on another tab requests no history.
    await act(async () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Files")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('.vx-toolbar button[aria-label="Refresh"]')!.click());
    expect(calls("list_resource_update_history")).toHaveLength(1);
  });

  it("makes Import the primary action, Check updates secondary and refresh an icon button", async () => {
    await render();
    const toolbar = container.querySelector<HTMLElement>(".vx-toolbar")!;
    const named = (label: string) => [...toolbar.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
    expect(named("Import resources").dataset.variant).toBe("primary");
    expect(named("Check updates").dataset.variant).toBe("secondary");
    const refresh = toolbar.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!;
    expect(refresh.classList.contains("vx-button--icon")).toBe(true);
    expect(buttons().some((item) => item.textContent === "Retry")).toBe(false);
    await act(async () => refresh.click());
    expect(calls("list_local_resources")).toHaveLength(2);
  });

  it("shows an empty folder as an inline empty state", async () => {
    files = [];
    await render();
    expect(container.querySelector(".vx-empty--inline h2")?.textContent).toBe("No resources in this category");
    expect(container.querySelector(".vx-empty--panel")).toBeNull();
  });
});
