// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLauncherI18n } from "../../i18n";
import type { Instance } from "../../lib/launcher";

const commandMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: commandMock,
}));
vi.mock("../../lib/nativePaths", () => ({ pickLauncherPath: vi.fn() }));
vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => ({ effects: "lite", reducedMotion: true }) }));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => ({ run: async (_scope: string, task: () => Promise<unknown>) => task() }),
}));

const { InstanceSettings } = await import("./InstanceSettings");

let container: HTMLDivElement;
let root: Root;
const base = {
  id: "fixture", name: "Fixture", category: "", notes: "", versionId: "1.20.1", loader: "forge",
} as unknown as Instance;

async function render(instance: Instance) {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(InstanceSettings, { instance, onChanged: async () => undefined }))));
}

async function setInput(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function save() {
  const button = [...container.querySelectorAll("button")].find(item => item.textContent === "Save")!;
  await act(async () => button.click());
  const call = [...commandMock.mock.calls].reverse().find((entry: unknown[]) => entry[0] === "update_instance");
  return call?.[1] as Record<string, unknown>;
}

describe("InstanceSettings memory fields", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    commandMock.mockReset();
    commandMock.mockResolvedValue(null);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows a legacy instance as manual and resubmits its maximum", async () => {
    await render({ ...base, maxMemoryMb: 2048 });
    expect(container.querySelector<HTMLInputElement>("#instance-memory")!.disabled).toBe(false);
    const payload = await save();
    expect(payload).toMatchObject({ memoryMode: "manual", maxMemoryMb: 2048, minMemoryMb: null, clearMinMemory: true });
  });

  it("clears a stored initial memory override explicitly", async () => {
    await render({ ...base, memoryMode: "auto", minMemoryMb: 1024 });
    expect(container.querySelector<HTMLInputElement>("#instance-memory")!.disabled).toBe(true);
    await setInput("instance-min-memory", "");
    const payload = await save();
    expect(payload).toMatchObject({ memoryMode: "auto", minMemoryMb: null, clearMinMemory: true });
  });

  it("submits a numeric initial memory without the clear flag", async () => {
    await render({ ...base });
    await setInput("instance-min-memory", "1536");
    const payload = await save();
    expect(payload).toMatchObject({ memoryMode: "inherit", minMemoryMb: 1536, clearMinMemory: false });
  });

  it("changes an existing instance's loader after fetching loader versions and confirming", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    commandMock.mockImplementation(async (name, args) => {
      if (name === "get_resource_context") return { gameVersion: "1.20.1", loader: "forge" };
      if (name === "list_loader_versions") {
        if (args?.loader === "fabric") {
          return [{ id: "0.16.10", stable: true, recommended: true }, { id: "0.16.9", stable: true, recommended: false }];
        }
        return [{ id: "47.2.0", stable: true, recommended: true }];
      }
      if (name === "change_instance_loader") {
        return { ...base, versionId: "fabric-loader-0.16.10-1.20.1", loader: "fabric", loaderVersion: "0.16.10" };
      }
      return null;
    });

    await render({ ...base, versionId: "1.20.1-forge-47.2.0", loader: "forge", loaderVersion: "47.2.0" });
    const fabricBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Fabric")!;
    await act(async () => fabricBtn.click());
    expect(commandMock).toHaveBeenCalledWith("list_loader_versions", { loader: "fabric", gameVersion: "1.20.1" });

    const applyBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Change loader")!;
    expect(applyBtn.disabled).toBe(false);
    await act(async () => applyBtn.click());
    expect(window.confirm).toHaveBeenCalled();
    expect(commandMock).toHaveBeenCalledWith("change_instance_loader", {
      instanceId: "fixture",
      loader: "fabric",
      loaderVersion: "0.16.10",
    });
    expect(container.textContent).toContain("Instance loader updated.");
  });

  it("switches an instance back to Vanilla without requiring a loader version", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    commandMock.mockImplementation(async (name) => {
      if (name === "get_resource_context") return { gameVersion: "1.20.1", loader: "forge" };
      if (name === "list_loader_versions") return [{ id: "47.2.0", stable: true, recommended: true }];
      if (name === "change_instance_loader") return { ...base, versionId: "1.20.1", loader: "vanilla", loaderVersion: "" };
      return null;
    });

    await render({ ...base, versionId: "1.20.1-forge-47.2.0", loader: "forge", loaderVersion: "47.2.0" });
    const vanillaBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Vanilla")!;
    await act(async () => vanillaBtn.click());
    const applyBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Change loader")!;
    await act(async () => applyBtn.click());
    expect(commandMock).toHaveBeenCalledWith("change_instance_loader", {
      instanceId: "fixture",
      loader: "vanilla",
      loaderVersion: null,
    });
  });

  it("imports a local OptiFine installer JAR for the current instance", async () => {
    const { pickLauncherPath } = await import("../../lib/nativePaths");
    vi.mocked(pickLauncherPath).mockResolvedValue("C:\\SyntheticFixture\\OptiFine_1.20.1_HD_U_I6.jar");
    commandMock.mockImplementation(async (name) => {
      if (name === "get_resource_context") return { gameVersion: "1.20.1", loader: "forge" };
      if (name === "list_loader_versions") return [];
      if (name === "install_optifine_installer") return { versionId: "1.20.1-OptiFine_HD_U_I6", loader: "optifine", loaderVersion: "HD_U_I6" };
      return null;
    });

    await render({ ...base, versionId: "1.20.1", loader: "vanilla", loaderVersion: "" });
    const ofBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "OptiFine")!;
    await act(async () => ofBtn.click());
    const importBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Import OptiFine installer JAR…")!;
    await act(async () => importBtn.click());
    expect(pickLauncherPath).toHaveBeenCalledWith("optifineInstaller");
    expect(commandMock).toHaveBeenCalledWith("install_optifine_installer", {
      path: "C:\\SyntheticFixture\\OptiFine_1.20.1_HD_U_I6.jar",
      expectedGameVersion: "1.20.1",
      instanceId: "fixture",
    });
  });
});
