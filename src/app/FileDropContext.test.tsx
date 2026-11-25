// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createLauncherI18n } from "../i18n";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener[]>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: Listener) => {
    const list = listeners.get(name) ?? [];
    list.push(cb);
    listeners.set(name, list);
    return () => {
      const current = listeners.get(name) ?? [];
      listeners.set(name, current.filter((item) => item !== cb));
    };
  }),
}));

vi.mock("../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/launcher")>()),
  desktop: true,
}));

import { droppedFileName, FileDropProvider, useFileDrop, type DroppedFiles } from "./FileDropContext";

function emitEvent(name: string, payload: unknown) {
  for (const cb of listeners.get(name) ?? []) cb({ payload });
}

describe("FileDropContext", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    listeners.clear();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("extracts base names for Windows and POSIX paths", () => {
    expect(droppedFileName("C:\\SyntheticFixture\\Downloads\\sodium.jar")).toBe("sodium.jar");
    expect(droppedFileName("/tmp/packs/alpha.mrpack")).toBe("alpha.mrpack");
  });

  it("shows the drag overlay with the highest-priority handler hint and routes drops by priority", async () => {
    const i18n = createLauncherI18n("en-US", "en-US");
    await i18n.initPromise;
    const low = vi.fn(() => true);
    const high = vi.fn((files: DroppedFiles) => files.mods.length > 0);
    const unhandled = vi.fn();

    function Harness() {
      useFileDrop(low, { priority: 0, hintKey: "shell:drop.hintGeneral" });
      useFileDrop(high, { priority: 20, hintKey: "shell:drop.hintInstanceContent" });
      return createElement("div", null, "content");
    }

    await act(async () => {
      root.render(
        createElement(I18nextProvider, { i18n },
          createElement(FileDropProvider, { onUnhandled: unhandled }, createElement(Harness))),
      );
    });

    await act(async () => {
      emitEvent("launcher://file-drag", { active: true, count: 2 });
    });
    const overlay = container.querySelector<HTMLElement>("[data-file-drop-overlay]");
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain(".jar");

    // Mod drop is consumed by high priority handler; low priority is not invoked.
    await act(async () => {
      emitEvent("launcher://file-drop", {
        mods: ["C:\\mods\\sodium.jar"],
        zips: [],
        modpacks: [],
        skins: [],
        unsupported: 0,
      });
    });
    expect(container.querySelector("[data-file-drop-overlay]")).toBeNull();
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();

    // Modpack drop falls through high priority to low priority handler.
    await act(async () => {
      emitEvent("launcher://file-drop", {
        mods: [],
        zips: [],
        modpacks: ["C:\\packs\\demo.mrpack"],
        skins: [],
        unsupported: 0,
      });
    });
    expect(low).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("invokes onUnhandled when no handler claims the dropped files", async () => {
    const i18n = createLauncherI18n("zh-CN", "zh-CN");
    await i18n.initPromise;
    const unhandled = vi.fn();

    await act(async () => {
      root.render(
        createElement(I18nextProvider, { i18n },
          createElement(FileDropProvider, { onUnhandled: unhandled }, createElement("div", null, "empty"))),
      );
    });

    await act(async () => {
      emitEvent("launcher://file-drop", { mods: [], zips: [], modpacks: [], skins: [], unsupported: 1 });
    });
    expect(unhandled).toHaveBeenCalledWith({ mods: [], zips: [], modpacks: [], skins: [], unsupported: 1 });
  });
});
