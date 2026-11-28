// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLauncherI18n } from "../../i18n";
import type { Instance } from "../../lib/launcher";
import { ConfirmContext, type ConfirmFn } from "../../components/ui/ConfirmDialog";

const commandMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: commandMock,
}));
vi.mock("../../lib/nativePaths", () => ({ pickLauncherPath: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => ({ effects: "lite", reducedMotion: true }) }));
// Like the real controller, a failed task ends as a notice, not a rejection.
const failures = vi.hoisted(() => [] as unknown[]);
const globalConfig = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => ({
    config: globalConfig.value,
    run: async (_scope: string, task: () => Promise<unknown>) => {
      try {
        return await task();
      } catch (error) {
        failures.push(error);
        return undefined;
      }
    },
  }),
}));

const { InstanceSettings } = await import("./InstanceSettings");
// Stands in for the awaited dialog; an unanswered confirmation declines.
const confirmMock = vi.fn<ConfirmFn>(async () => false);

let container: HTMLDivElement;
let root: Root;
const base = {
  id: "fixture", name: "Fixture", category: "", notes: "", versionId: "1.20.1", loader: "forge",
} as unknown as Instance;

async function render(instance: Instance) {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(ConfirmContext.Provider, { value: confirmMock },
      createElement(InstanceSettings, { instance, onChanged: async () => undefined })))));
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
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(false);
    failures.length = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    globalConfig.value = undefined;
  });

  it("shows what each empty override inherits from the global settings", async () => {
    globalConfig.value = { memoryMode: "manual", maxMemoryMb: 4096, minMemoryMb: null, javaPath: "", jvmArguments: "-XX:+UseG1GC", screenWidth: 1280, screenHeight: 720 };
    await render({ ...base });
    const placeholder = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!.placeholder;
    expect(placeholder("instance-memory")).toBe("Global: 4096");
    expect(placeholder("instance-min-memory")).toBe("Global setting");
    expect(placeholder("instance-java")).toBe("Global setting");
    expect(placeholder("instance-jvm")).toBe("Global: -XX:+UseG1GC");
    expect(placeholder("instance-width")).toBe("Global: 1280");
    expect(placeholder("instance-height")).toBe("Global: 720");
    await render({ ...base, memoryMode: "auto" });
    expect(placeholder("instance-memory")).toBe("Automatic memory");
  });

  it("attaches Choose Java to the right of the Java field", async () => {
    await render({ ...base });
    const group = container.querySelector<HTMLElement>(".vx-detail-input-action")!;
    expect(group.firstElementChild?.id).toBe("instance-java");
    expect(group.lastElementChild?.textContent).toBe("Choose Java");
  });

  it("keeps Save in a bar with Discard and an unsaved-changes mark", async () => {
    await render({ ...base, name: "Fixture" });
    const bar = container.querySelector<HTMLElement>(".vx-detail-savebar")!;
    const named = (label: string) => [...bar.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!;
    expect(named("Save").dataset.variant).toBe("primary");
    expect(named("Save").type).toBe("submit");
    expect(named("Discard changes").disabled).toBe(true);
    expect(bar.querySelector('[role="status"]')?.textContent).toBe("");
    await setInput("instance-name", "Renamed");
    expect(bar.querySelector('[role="status"]')?.textContent).toBe("Unsaved changes");
    expect(named("Discard changes").disabled).toBe(false);
    await act(async () => named("Discard changes").click());
    expect(container.querySelector<HTMLInputElement>("#instance-name")!.value).toBe("Fixture");
    expect(bar.querySelector('[role="status"]')?.textContent).toBe("");
    expect(commandMock.mock.calls.some(([name]) => name === "update_instance")).toBe(false);
    expect([...container.querySelectorAll("form > .vx-button")]).toHaveLength(0);
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
    confirmMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    commandMock.mockImplementation(async (name, args) => {
      if (name === "get_resource_context") return { gameVersion: "1.20.1", loader: "forge" };
      if (name === "list_loader_versions") {
        if (args?.loader === "fabric") {
          return [{ id: "0.16.10", stable: true, recommended: true }, { id: "0.16.9", stable: true, recommended: false }];
        }
        return [{ id: "47.2.0", stable: true, recommended: true }];
      }
      if (name === "change_instance_loader") {
        return { ...base, versionId: "fabric-loader-0.16.10-1.20.1", loader: "fabric", loaderVersion: "0.16.10", backupId: "backup-fixture" };
      }
      return null;
    });

    await render({ ...base, versionId: "1.20.1-forge-47.2.0", loader: "forge", loaderVersion: "47.2.0" });
    const fabricBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Fabric")!;
    await act(async () => fabricBtn.click());
    expect(commandMock).toHaveBeenCalledWith("list_loader_versions", { loader: "fabric", gameVersion: "1.20.1" });

    const applyBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Change loader")!;
    expect(applyBtn.disabled).toBe(false);
    // Cancelling the confirmation leaves the loader alone.
    await act(async () => applyBtn.click());
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const confirmation = confirmMock.mock.calls[0]?.[0] ?? "";
    expect(confirmation).toContain("backup");
    expect(confirmation).toContain("permanently lose");
    expect(confirmMock.mock.calls[0]?.[1]).toMatchObject({ tone: "danger" });
    expect(commandMock.mock.calls.some(([name]) => name === "change_instance_loader")).toBe(false);
    expect(container.textContent).not.toContain("Instance loader updated.");

    await act(async () => applyBtn.click());
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(commandMock).toHaveBeenCalledWith("change_instance_loader", {
      instanceId: "fixture",
      loader: "fabric",
      loaderVersion: "0.16.10",
      skipBackup: false,
    });
    expect(container.textContent).toContain("Instance loader updated. A backup of the previous instance was saved first.");
  });

  it("switches an instance back to Vanilla without requiring a loader version", async () => {
    confirmMock.mockResolvedValue(true);
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
      skipBackup: false,
    });
  });

  it("imports a local OptiFine installer JAR for the current instance and never lists OptiFine builds", async () => {
    const { pickLauncherPath } = await import("../../lib/nativePaths");
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    vi.mocked(pickLauncherPath).mockClear();
    vi.mocked(pickLauncherPath).mockResolvedValue("C:\\SyntheticFixture\\OptiFine_1.20.1_HD_U_I6.jar");
    confirmMock.mockResolvedValue(true);
    commandMock.mockImplementation(async (name) => {
      if (name === "get_resource_context") return { gameVersion: "1.20.1", loader: "forge" };
      if (name === "list_loader_versions") return [{ id: "HD_U_I6", stable: true, recommended: true }];
      if (name === "install_optifine_installer") return { versionId: "1.20.1-OptiFine_HD_U_I6", loader: "optifine", loaderVersion: "HD_U_I6", backupId: "backup-fixture" };
      return null;
    });

    await render({ ...base, versionId: "1.20.1", loader: "vanilla", loaderVersion: "" });
    const ofBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "OptiFine")!;
    await act(async () => ofBtn.click());
    // Only the local import is offered: no build list, no online apply.
    expect(commandMock.mock.calls.some(([name, args]) => name === "list_loader_versions" && args?.loader === "optifine")).toBe(false);
    expect(container.querySelector("#instance-loader-version")).toBeNull();
    expect([...container.querySelectorAll("button")].some(b => b.textContent?.trim() === "Change loader")).toBe(false);
    expect(container.textContent).toContain("Voxelight does not download OptiFine");
    const site = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(a => a.textContent === "OptiFine downloads (optifine.net)")!;
    expect(site.getAttribute("href")).toBe("https://optifine.net/downloads");
    await act(async () => site.click());
    expect(openUrl).toHaveBeenCalledWith("https://optifine.net/downloads");
    // The native opener only opens listed pages, so the link must be in its scope.
    const capability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8")) as {
      permissions: Array<string | { identifier: string; allow?: Array<{ url: string }> }>;
    };
    const opener = capability.permissions.find((entry) => typeof entry === "object" && entry.identifier === "opener:allow-open-url");
    expect(typeof opener === "object" ? opener.allow?.map(({ url }) => url) : []).toContain("https://optifine.net/downloads");

    const importBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Import OptiFine installer JAR…")!;
    // Switching to OptiFine is a loader change, so it is confirmed first, and
    // cancelling it opens no file picker and installs nothing.
    confirmMock.mockResolvedValueOnce(false);
    await act(async () => importBtn.click());
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]?.[0]).toContain("permanently lose");
    expect(confirmMock.mock.calls[0]?.[1]).toMatchObject({ tone: "danger" });
    expect(pickLauncherPath).not.toHaveBeenCalled();
    expect(commandMock.mock.calls.some(([name]) => name === "install_optifine_installer")).toBe(false);

    await act(async () => importBtn.click());
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(pickLauncherPath).toHaveBeenCalledWith("optifineInstaller");
    // The Minecraft version comes from the JAR and is checked by the backend
    // against this instance; the window sends no version of its own.
    expect(commandMock).toHaveBeenCalledWith("install_optifine_installer", {
      path: "C:\\SyntheticFixture\\OptiFine_1.20.1_HD_U_I6.jar",
      instanceId: "fixture",
      skipBackup: false,
    });
    expect(container.textContent).toContain("A backup of the previous instance was saved first.");
  });

  it("keeps the OptiFine import unavailable until the Minecraft version of the instance is known", async () => {
    let answer: (value: unknown) => void = () => undefined;
    commandMock.mockImplementation(async (name) => name === "get_resource_context"
      ? new Promise(resolve => { answer = resolve; })
      : null);
    await render({ ...base, versionId: "1.20.1-OptiFine_HD_U_I6", loader: "optifine", loaderVersion: "HD_U_I6" });
    const importBtn = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Import OptiFine installer JAR…")!;
    expect(importBtn().disabled).toBe(true);
    await act(async () => answer({ gameVersion: "1.20.1", loader: "optifine" }));
    expect(importBtn().disabled).toBe(false);
  });

  it("switches without a backup only after a second confirmation that names why the backup was refused", async () => {
    const confirm = confirmMock.mockResolvedValue(true);
    commandMock.mockImplementation(async (name, args) => {
      if (name === "get_resource_context") return { gameVersion: "1.20.1", loader: "forge" };
      if (name === "list_loader_versions") return [{ id: "0.16.10", stable: true, recommended: true }];
      if (name === "change_instance_loader" && !args?.skipBackup) {
        throw { code: "loader.switchBackupNoSpace", params: { needed: 2048, available: 300 } };
      }
      if (name === "change_instance_loader") return { ...base, loader: "fabric", backupId: null };
      return null;
    });
    await render({ ...base, versionId: "1.20.1-forge-47.2.0", loader: "forge", loaderVersion: "47.2.0" });
    const fabricBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Fabric")!;
    await act(async () => fabricBtn.click());
    const applyBtn = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Change loader")!;

    // Declining the second confirmation keeps the refusal and changes nothing.
    confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await act(async () => applyBtn().click());
    const second = confirm.mock.calls[1]?.[0] ?? "";
    expect(confirm.mock.calls[1]?.[1]).toMatchObject({ tone: "danger" });
    expect(second).toContain("has 300 MB free, and the backup needs about 2048 MB");
    expect(second).toContain("without a backup");
    expect(commandMock.mock.calls.filter(([name]) => name === "change_instance_loader")).toHaveLength(1);
    expect(failures).toHaveLength(1);

    // Accepting it retries with the explicit choice.
    confirm.mockClear();
    confirm.mockResolvedValue(true);
    await act(async () => applyBtn().click());
    expect(confirm).toHaveBeenCalledTimes(2);
    const calls = commandMock.mock.calls.filter(([name]) => name === "change_instance_loader");
    expect(calls.map(([, args]) => args?.skipBackup)).toEqual([false, false, true]);
    expect(container.textContent).toContain("Instance loader updated.");
    expect(container.textContent).not.toContain("A backup of the previous instance was saved first.");
  });

  it("does not offer to skip the backup when the user cancelled it or the install failed", async () => {
    const confirm = confirmMock.mockResolvedValue(true);
    const errors = [{ code: "download.cancelled", params: {} }, { code: "internal.unexpected", params: {} }];
    commandMock.mockImplementation(async (name) => {
      if (name === "get_resource_context") return { gameVersion: "1.20.1", loader: "forge" };
      if (name === "list_loader_versions") return [{ id: "0.16.10", stable: true, recommended: true }];
      if (name === "change_instance_loader") throw errors.shift();
      return null;
    });
    await render({ ...base, versionId: "1.20.1-forge-47.2.0", loader: "forge", loaderVersion: "47.2.0" });
    const fabricBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Fabric")!;
    await act(async () => fabricBtn.click());
    const applyBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Change loader")!;
    await act(async () => applyBtn.click());
    await act(async () => applyBtn.click());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(commandMock.mock.calls.filter(([name]) => name === "change_instance_loader").map(([, args]) => args?.skipBackup)).toEqual([false, false]);
    expect(failures).toHaveLength(2);
  });

  it("retries an OptiFine import without a backup after the second confirmation", async () => {
    const { pickLauncherPath } = await import("../../lib/nativePaths");
    vi.mocked(pickLauncherPath).mockClear();
    vi.mocked(pickLauncherPath).mockResolvedValue("C:\\SyntheticFixture\\OptiFine_1.20.1_HD_U_I6.jar");
    const confirm = confirmMock.mockResolvedValue(true);
    commandMock.mockImplementation(async (name, args) => {
      if (name === "get_resource_context") return { gameVersion: "1.20.1", loader: "forge" };
      if (name === "install_optifine_installer" && !args?.skipBackup) throw { code: "loader.switchBackupLinks", params: {} };
      if (name === "install_optifine_installer") return { versionId: "1.20.1-OptiFine_HD_U_I6", loader: "optifine", loaderVersion: "HD_U_I6" };
      return null;
    });
    await render({ ...base, versionId: "1.20.1-forge-47.2.0", loader: "forge", loaderVersion: "47.2.0" });
    const ofBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "OptiFine")!;
    await act(async () => ofBtn.click());
    const importBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Import OptiFine installer JAR…")!;
    await act(async () => importBtn.click());
    expect(confirm.mock.calls[1]?.[0]).toContain("directory junction");
    const calls = commandMock.mock.calls.filter(([name]) => name === "install_optifine_installer");
    expect(calls.map(([, args]) => args?.skipBackup)).toEqual([false, true]);
    expect(pickLauncherPath).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Instance loader updated.");
  });
});
