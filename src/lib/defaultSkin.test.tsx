// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { command } from "./launcher";
import { useDefaultSkin, type DefaultSkin, type DefaultSkinId } from "./defaultSkin";

vi.mock("./launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./launcher")>()),
  desktop: true,
  command: vi.fn(),
}));

const baseSkin: DefaultSkin = {
  id: "steve",
  name: "Steve",
  dataUrl: "data:image/png;base64,Zml4dHVyZQ==",
  model: "classic",
};

let container: HTMLDivElement;
let root: Root | undefined;
let current: ReturnType<typeof useDefaultSkin>;

function Hook({ id, version, enabled }: { id: DefaultSkinId; version?: string; enabled?: boolean }) {
  current = useDefaultSkin(id, version, enabled);
  return null;
}

async function render(id: DefaultSkinId, version?: string, enabled?: boolean) {
  await act(async () => {
    root?.render(createElement(Hook, { id, version, enabled }));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    const currentRoot = root;
    root = undefined;
    await act(async () => currentRoot.unmount());
  }
  container.remove();
  vi.clearAllMocks();
});

describe("default skin resources", () => {
  it("does not fetch a default client when the account appearance already supplies the preview", async () => {
    await render("steve", "1.20.1", false);
    expect(command).not.toHaveBeenCalled();
    expect(current.skin.isFallback).toBe(true);
    expect(current.skin.dataUrl).toBe("");
    expect(current.loading).toBe(false);
  });

  it("requests the selected official character with the selected version", async () => {
    vi.mocked(command).mockResolvedValue({
      ...baseSkin,
      id: "alex",
      name: "Alex",
      model: "slim",
      sourceVersion: "1.20.1",
    });
    await render("alex", "1.20.1");
    expect(command).toHaveBeenCalledWith("get_default_skin", {
      skin: "alex",
      versionId: "1.20.1",
    });
    expect(current.skin.id).toBe("alex");
    expect(current.skin.model).toBe("slim");
    expect(current.error).toBe("");
  });

  it("does not let a slow request overwrite a newer selection", async () => {
    const resolvers: ((value: unknown) => void)[] = [];
    vi.mocked(command).mockImplementation((name) => {
      if (name !== "get_default_skin") return Promise.reject(new Error("Unexpected command"));
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    });
    await render("steve", "1.20.1");
    await render("alex", "1.20.1");
    expect(command).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolvers[1]({ ...baseSkin, id: "alex", name: "Alex", model: "slim" });
    });
    expect(current.skin.id).toBe("alex");
    await act(async () => {
      resolvers[0]({ ...baseSkin, id: "steve", name: "Steve" });
    });
    expect(current.skin.id).toBe("alex");
    expect(current.skin.model).toBe("slim");
  });

  it("reports failures with an empty preview instead of substituting another character", async () => {
    vi.mocked(command).mockRejectedValue(new Error("客户端尚未安装"));
    await render("steve");
    expect(current.skin.dataUrl).toBe("");
    expect(current.skin.isFallback).toBe(true);
    expect(current.error).toContain("客户端尚未安装");
    expect(current.error).not.toContain("Lumen");
  });
});
