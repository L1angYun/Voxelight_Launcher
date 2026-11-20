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
});
