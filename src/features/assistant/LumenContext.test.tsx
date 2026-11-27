// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaults } from "../../lib/launcher";

const commandMock = vi.fn();
const eventsMock = vi.fn(async (_name: string, _handler: (payload: unknown) => void) => () => {});

vi.mock("../../lib/launcher", async () => {
  const actual = await vi.importActual<typeof import("../../lib/launcher")>("../../lib/launcher");
  return {
    ...actual,
    desktop: true,
    command: (name: string, args?: Record<string, unknown>) => commandMock(name, args),
    events: (name: string, handler: (payload: unknown) => void) => eventsMock(name, handler),
  };
});

vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => ({
    bootstrapped: true,
    config: { ...defaults, assistantModel: "gpt-4o-mini" },
    running: [],
    data: { instances: [] },
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { LumenProvider, useLumen, type LumenContextValue } from "./LumenContext";

const readyStatus = {
  apiKeyConfigured: true,
  provider: "openai",
  baseUrl: "",
  effectiveBaseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  permission: "controlled",
  proactive: true,
  loopbackEndpoint: false,
  ready: true,
  mcp: { running: false, port: 25590, url: null, tokenMasked: null },
  tools: [],
};

let container: HTMLDivElement;
let root: Root;
let latest: LumenContextValue;

function Probe() {
  latest = useLumen();
  return null;
}

async function mountProvider() {
  await act(async () => {
    root.render(createElement(LumenProvider, null, createElement(Probe)));
    await Promise.resolve();
  });
}

describe("LumenContext", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    commandMock.mockReset();
    eventsMock.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("fails closed when status IPC throws after previously being ready", async () => {
    commandMock.mockResolvedValueOnce(readyStatus);
    await mountProvider();
    expect(latest.configured).toBe(true);

    await act(async () => {
      latest.openLumen({ reason: "crash", prompt: "diagnose", autoSend: true });
    });
    expect(latest.open).toBe(true);
    expect(latest.wakeRequest).not.toBeNull();

    commandMock.mockRejectedValueOnce(new Error("ipc failure"));
    await act(async () => {
      await latest.refreshStatus();
    });
    expect(latest.configured).toBe(false);
    expect(latest.open).toBe(false);
    expect(latest.wakeRequest).toBeNull();
  });

  it("clears pending wakeRequest when closing Lumen", async () => {
    commandMock.mockResolvedValue(readyStatus);
    await mountProvider();
    expect(latest.configured).toBe(true);

    await act(async () => {
      latest.openLumen({ reason: "crash", prompt: "diagnose", autoSend: true });
    });
    expect(latest.wakeRequest?.prompt).toBe("diagnose");

    await act(async () => {
      latest.closeLumen();
    });
    expect(latest.open).toBe(false);
    expect(latest.wakeRequest).toBeNull();
  });

  it("ignores stale out-of-order refreshStatus responses", async () => {
    let resolveFirst!: (val: unknown) => void;
    let resolveSecond!: (val: unknown) => void;
    commandMock
      .mockResolvedValueOnce(readyStatus)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    await mountProvider();
    expect(latest.configured).toBe(true);

    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    await act(async () => {
      p1 = latest.refreshStatus();
      p2 = latest.refreshStatus();
    });

    await act(async () => {
      resolveSecond({ ...readyStatus, ready: false });
      await p2;
    });
    expect(latest.configured).toBe(false);

    await act(async () => {
      resolveFirst(readyStatus);
      await p1;
    });
    expect(latest.configured).toBe(false);
  });

  it("wakes Lumen proactively on non-zero game exit and ignores clean exits", async () => {
    let gameExitHandler: ((payload: { gameId: string; pid: number; code: number | null }) => void) | null = null;
    eventsMock.mockImplementationOnce(async (name: string, handler: (payload: unknown) => void) => {
      if (name === "launcher://game-exit") {
        gameExitHandler = handler as typeof gameExitHandler;
      }
      return () => {};
    });
    commandMock.mockResolvedValue(readyStatus);
    await mountProvider();
    expect(latest.managed).toBe(true);
    expect(gameExitHandler).not.toBeNull();

    await act(async () => {
      gameExitHandler!({ gameId: "g-ok", pid: 100, code: 0 });
      gameExitHandler!({ gameId: "g-null", pid: 101, code: null });
    });
    expect(latest.open).toBe(false);

    await act(async () => {
      gameExitHandler!({ gameId: "g-crash", pid: 102, code: -1 });
    });
    expect(latest.open).toBe(true);
    expect(latest.wakeRequest?.autoSend).toBe(true);
  });

  it("does not wake Lumen when the launcher itself stopped the game", async () => {
    let gameExitHandler: ((payload: { gameId: string; pid: number; code: number | null; requestedStop?: boolean }) => void) | null = null;
    eventsMock.mockImplementationOnce(async (name: string, handler: (payload: unknown) => void) => {
      if (name === "launcher://game-exit") {
        gameExitHandler = handler as typeof gameExitHandler;
      }
      return () => {};
    });
    commandMock.mockResolvedValue(readyStatus);
    await mountProvider();
    expect(gameExitHandler).not.toBeNull();

    await act(async () => {
      gameExitHandler!({ gameId: "g-forced", pid: 200, code: 1, requestedStop: true });
    });
    expect(latest.open).toBe(false);
    expect(latest.wakeRequest).toBeNull();

    await act(async () => {
      gameExitHandler!({ gameId: "g-crash", pid: 201, code: 1, requestedStop: false });
    });
    expect(latest.open).toBe(true);
    expect(latest.wakeRequest?.autoSend).toBe(true);
  });

  it("does not subscribe to crash wake-up when proactive mode is disabled", async () => {
    commandMock.mockResolvedValue({ ...readyStatus, proactive: false });
    await mountProvider();
    expect(latest.configured).toBe(true);
    expect(latest.proactive).toBe(false);
    expect(eventsMock).not.toHaveBeenCalled();
  });
});
