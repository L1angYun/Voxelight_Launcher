// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { command, type Account } from "./launcher";
import { useAccountSkin } from "./accountSkin";

vi.mock("./launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./launcher")>()),
  command: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root | undefined;
let current: ReturnType<typeof useAccountSkin>;

function account(id: string, skinUrl?: string): Account {
  return {
    id,
    username: id,
    uuid: id,
    type: "microsoft",
    isSelected: true,
    skinUrl,
    skinModel: "classic",
  };
}

function Hook({ value }: { value?: Account }) {
  current = useAccountSkin(value);
  return null;
}

async function render(value?: Account) {
  await act(async () => {
    root?.render(createElement(Hook, { value }));
  });
}

function profile(id: string, model: "classic" | "slim" = "slim") {
  return {
    id,
    name: id,
    skins: [
      {
        id: `${id}-skin`,
        state: "ACTIVE",
        url: `https://textures.minecraft.net/texture/${id}`,
        variant: model,
      },
    ],
    capes: [
      {
        id: `${id}-cape`,
        state: "ACTIVE",
        url: `https://textures.minecraft.net/texture/${id}-cape`,
      },
    ],
  };
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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

describe("account-owned appearance", () => {
  it("uses the active account skin, model and cape instead of a stored fallback", async () => {
    vi.mocked(command).mockResolvedValue(profile("current-user"));
    await render(
      account("current-user", "https://textures.minecraft.net/texture/old"),
    );
    expect(command).toHaveBeenCalledWith("get_player_profile", {
      accountId: "current-user",
    });
    expect(current.skinUrl).toBe(
      "https://textures.minecraft.net/texture/current-user",
    );
    expect(current.model).toBe("slim");
    expect(current.capeUrl).toBe(
      "https://textures.minecraft.net/texture/current-user-cape",
    );
    expect(current.hasAccountSkin).toBe(true);
    expect(current.error).toBe("");
  });

  it("does not show the previous account when an older profile request finishes late", async () => {
    const resolvers: ((value: unknown) => void)[] = [];
    vi.mocked(command).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    await render(account("first-user"));
    await render(account("second-user"));
    expect(command).toHaveBeenCalledTimes(2);
    await act(async () => resolvers[1](profile("second-user")));
    expect(current.profile?.id).toBe("second-user");
    await act(async () => resolvers[0](profile("first-user")));
    expect(current.profile?.id).toBe("second-user");
    expect(current.skinUrl).toBe(
      "https://textures.minecraft.net/texture/second-user",
    );
  });

  it("reports a failed profile load without inventing an account skin", async () => {
    vi.mocked(command).mockRejectedValue(new Error("授权已过期"));
    await render(account("needs-refresh"));
    expect(current.error).toContain("授权已过期");
    expect(current.skinUrl).toBeUndefined();
    expect(current.hasAccountSkin).toBe(false);
  });

  it("keeps a stored account skin on a refresh failure and never fetches offline accounts", async () => {
    const stored = account(
      "stored-user",
      "https://textures.minecraft.net/texture/stored-user",
    );
    vi.mocked(command).mockRejectedValue(new Error("暂时无法刷新"));
    await render(stored);
    expect(current.skinUrl).toBe(
      "https://textures.minecraft.net/texture/stored-user",
    );
    expect(current.error).toContain("暂时无法刷新");
    await render({ ...stored, type: "offline", skinUrl: undefined });
    expect(current.skinUrl).toBeUndefined();
    expect(current.error).toBe("");
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("lets the current classic profile override an older slim account setting", async () => {
    vi.mocked(command).mockResolvedValue(profile("classic-user", "classic"));
    await render({ ...account("classic-user"), skinModel: "slim" });
    expect(current.model).toBe("classic");
    expect(current.skinUrl).toBe(
      "https://textures.minecraft.net/texture/classic-user",
    );
  });

  it("clears a cached custom skin and model after a successful empty profile", async () => {
    vi.mocked(command).mockResolvedValue({
      id: "reset-user",
      name: "reset-user",
      skins: [],
      capes: [],
    });
    await render({
      ...account(
        "reset-user",
        "https://textures.minecraft.net/texture/removed",
      ),
      skinModel: "slim",
    });
    expect(current.profile?.id).toBe("reset-user");
    expect(current.skinUrl).toBeUndefined();
    expect(current.model).toBe("auto");
    expect(current.capeUrl).toBeUndefined();
    expect(current.error).toBe("");
  });

  it("keeps a successful empty profile during a same-account retry and its failure", async () => {
    vi.mocked(command).mockResolvedValueOnce({
      id: "retry-empty",
      name: "retry-empty",
      skins: [],
      capes: [],
    });
    await render({
      ...account(
        "retry-empty",
        "https://textures.minecraft.net/texture/removed",
      ),
      skinModel: "slim",
    });
    let rejectRetry: ((reason: unknown) => void) | undefined;
    vi.mocked(command).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRetry = reject;
        }),
    );
    await act(async () => current.refresh());
    expect(current.loading).toBe(true);
    expect(current.profile?.skins).toEqual([]);
    expect(current.skinUrl).toBeUndefined();
    await act(async () => rejectRetry?.(new Error("刷新失败")));
    expect(current.profile?.skins).toEqual([]);
    expect(current.skinUrl).toBeUndefined();
    expect(current.model).toBe("auto");
    expect(current.error).toContain("刷新失败");
  });

  it("rejects a profile belonging to another Minecraft identity", async () => {
    vi.mocked(command).mockResolvedValue(profile("b".repeat(32)));
    await render({ ...account("identity-check"), uuid: "a".repeat(32) });
    expect(current.skinUrl).toBeUndefined();
    expect(current.error).toContain("身份与当前账号不一致");
    expect(current.hasAccountSkin).toBe(false);
  });
});
