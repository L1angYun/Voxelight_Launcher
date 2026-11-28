// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createLauncherI18n, type LauncherI18n } from "../../i18n";
import { command, type LogEntry, type RunningGame } from "../../lib/launcher";
import { InstanceLogs } from "./InstanceLogs";
import type { GameLog, GameLogLine } from "./types";

const commandMock = vi.mocked(command);
let mockLauncher: {
  logs: LogEntry[];
  running: RunningGame[];
  run: (key: string, action: () => Promise<unknown>) => Promise<unknown>;
};
let i18n: LauncherI18n;
let root: Root;
let container: HTMLDivElement;

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  desktop: true,
}));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => mockLauncher,
}));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

const logPath = "C:\\SyntheticFixture\\world\\logs\\latest.log";
const lines: GameLogLine[] = [
  { time: "12:34:56", thread: "Server thread", level: "info", message: "Starting minecraft server version 1.21.1" },
  { time: "12:34:57", thread: "main", level: "warn", message: "Risky option enabled" },
  { time: "12:34:58", thread: "Render thread", level: "error", message: "java.lang.OutOfMemoryError: Java heap space\n\tat net.minecraft.Foo.bar(Foo.java:1)" },
  { time: "12:34:59", thread: "Worker-Main-1", level: "debug", message: "debug detail" },
  { time: "12:35:00", thread: null, level: "other", message: "raw continuation" },
];
const gameLog: GameLog = { path: logPath, lines, truncated: false };

function instanceLogs() {
  return createElement(InstanceLogs, { versionId: "1.21.1", instanceId: "fixture-world" });
}

async function render(node: ReactNode) {
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, node)));
}

function readCalls() {
  return commandMock.mock.calls.filter(([name]) => name === "read_game_log").length;
}

function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim().startsWith(label));
}

async function setSearch(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  commandMock.mockReset();
  commandMock.mockImplementation(async (name) => name === "read_game_log" ? gameLog : null);
  mockLauncher = {
    logs: [],
    running: [],
    run: (_key, action) => action(),
  };
  i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("instance game log", () => {
  it("renders each record with its time, level, thread, and multi-line message", async () => {
    await render(instanceLogs());
    const rows = container.querySelectorAll(".vx-game-log__line");
    expect(rows).toHaveLength(lines.length);
    expect(rows[0].querySelector(".vx-game-log__time")?.textContent).toBe("12:34:56");
    expect(rows[0].querySelector(".vx-game-log__level")?.textContent).toBe("Info");
    expect(rows[0].querySelector(".vx-game-log__thread")?.textContent).toBe("Server thread");
    expect(rows[0].querySelector(".vx-game-log__message")?.textContent).toBe("Starting minecraft server version 1.21.1");
    expect(rows[2].querySelector(".vx-game-log__level")?.textContent).toBe("Error");
    expect(rows[2].querySelector(".vx-game-log__message")?.textContent).toContain("\n\tat net.minecraft");
    expect(rows[4].querySelector(".vx-game-log__level")?.textContent).toBe("Other");
    expect(container.querySelector(".vx-game-log__path")?.textContent).toContain(logPath);
  });

  it("counts the search matches and filters by level", async () => {
    await render(instanceLogs());
    expect(button("All (5)")).toBeDefined();
    expect(button("Errors (1)")).toBeDefined();
    expect(button("Warnings (1)")).toBeDefined();
    expect(button("Info (1)")).toBeDefined();

    await setSearch("RENDER");
    expect(container.querySelectorAll(".vx-game-log__line")).toHaveLength(1);
    expect(container.querySelector(".vx-game-log__line .vx-game-log__level")?.textContent).toBe("Error");
    expect(button("All (1)")).toBeDefined();
    expect(button("Errors (1)")).toBeDefined();
    expect(button("Warnings (0)")).toBeDefined();
    expect(button("Info (0)")).toBeDefined();

    await setSearch("risky");
    expect(container.querySelectorAll(".vx-game-log__line")).toHaveLength(1);
    expect(container.querySelector(".vx-game-log__line .vx-game-log__level")?.textContent).toBe("Warning");

    await setSearch("");
    await act(async () => button("Warnings (1)")!.click());
    expect(container.querySelectorAll(".vx-game-log__line")).toHaveLength(1);
    expect(container.querySelector(".vx-game-log__message")?.textContent).toBe("Risky option enabled");

    await act(async () => button("Errors (1)")!.click());
    expect(container.querySelectorAll(".vx-game-log__line")).toHaveLength(1);
    expect(container.querySelector(".vx-game-log__message")?.textContent).toContain("OutOfMemoryError");

    await setSearch("no such line");
    expect(container.querySelector(".vx-game-log__line")).toBeNull();
    expect(container.textContent).toContain("No log lines match the search or filter.");
  });

  it("refreshes with the instance version and id", async () => {
    await render(instanceLogs());
    expect(commandMock).toHaveBeenCalledWith("read_game_log", {
      versionId: "1.21.1", instanceId: "fixture-world",
    });
    commandMock.mockClear();
    await act(async () => button("Refresh")!.click());
    expect(commandMock).toHaveBeenCalledWith("read_game_log", {
      versionId: "1.21.1", instanceId: "fixture-world",
    });
  });

  it("refreshes every three seconds while running and stops after exit or unmount", async () => {
    vi.useFakeTimers();
    const running = { gameId: "game-1", pid: 123, versionId: "1.21.1", instanceId: "fixture-world" };
    mockLauncher.running = [running];
    await render(instanceLogs());
    expect(readCalls()).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(readCalls()).toBe(2);

    mockLauncher.running = [];
    await render(instanceLogs());
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(readCalls()).toBe(2);

    mockLauncher.running = [running];
    await render(instanceLogs());
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(readCalls()).toBe(3);

    await render(null);
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(readCalls()).toBe(3);
  });

  it("shows an empty state when the game has no log yet", async () => {
    commandMock.mockImplementation(async (name) => name === "read_game_log"
      ? { path: null, lines: [], truncated: false } : null);
    await render(instanceLogs());
    expect(container.textContent).toContain("No game log yet");
    expect(container.textContent).toContain("Start this instance once");
    expect(container.querySelector(".vx-game-log__line")).toBeNull();
    expect(container.querySelector(".vx-game-log__path")).toBeNull();
  });

  it("refreshes the game log from an icon button in its heading", async () => {
    await render(instanceLogs());
    const refresh = container.querySelector<HTMLButtonElement>('.vx-section-heading button[aria-label="Refresh"]');
    expect(refresh?.classList.contains("vx-button--icon")).toBe(true);
    expect(refresh?.closest(".vx-section-heading")?.querySelector("h2")?.textContent).toBe("Game log");
  });

  it("shows the three empty sections as inline empty states without a placeholder log box", async () => {
    commandMock.mockImplementation(async (name) => name === "read_game_log"
      ? { path: null, lines: [], truncated: false } : null);
    await render(instanceLogs());
    const titles = [...container.querySelectorAll(".vx-empty--inline h2")].map((title) => title.textContent);
    expect(titles).toEqual(["No launch analysis yet", "No game log yet", "No launcher logs yet"]);
    expect(container.querySelector(".vx-empty--panel")).toBeNull();
    expect(container.querySelector("pre.vx-log-view")).toBeNull();
    expect(container.querySelector(".vx-game-log__toolbar")).toBeNull();
    expect(container.querySelector('input[type="search"]')).toBeNull();
    mockLauncher.logs = [{ timestamp: "12:00:00", level: "info", message: "Launcher ready" } as LogEntry];
    await render(instanceLogs());
    expect(container.querySelector("pre.vx-log-view")?.textContent).toBe("[12:00:00] Launcher ready");
  });

  it("shows the path and how many tail lines were kept when truncated", async () => {
    commandMock.mockImplementation(async (name) => name === "read_game_log"
      ? { path: logPath, lines: lines.slice(0, 2), truncated: true } : null);
    await render(instanceLogs());
    expect(container.textContent).toContain("Showing the last 2 lines.");
    expect(container.querySelectorAll(".vx-game-log__line")).toHaveLength(2);
    expect(container.querySelector(".vx-game-log__path")?.textContent).toContain(logPath);
  });
});
