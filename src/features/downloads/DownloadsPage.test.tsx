// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { command, events } from "../../lib/launcher";
import { LauncherError } from "../../lib/errors";
import { resetViewState } from "../../app/viewState";
import { createLauncherI18n } from "../../i18n";
import { ConfirmContext, type ConfirmFn } from "../../components/ui/ConfirmDialog";
import { DownloadsPage } from "./DownloadsPage";
import { TaskList } from "./TaskList";
import {
  taskActions,
  useDownloadTasks,
  type DownloadTask,
  type DownloadTasksModel,
} from "./useDownloadTasks";

const commandMock = vi.mocked(command);
const eventsMock = vi.mocked(events);
const listeners = new Map<string, (value: unknown) => void>();
let root: Root;
let container: HTMLDivElement;
let currentTasks: DownloadTask[];
let revision: number;
const snapshot = () => ({ revision, tasks: currentTasks });
let latestModel: DownloadTasksModel;
const confirmMock = vi.fn<ConfirmFn>(async () => true);

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  events: vi.fn(),
}));
vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => ({
  effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false,
}) }));

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: "task-1",
    kind: "install",
    target: "1.21.1",
    label: "Legacy task label",
    status: "running",
    stage: "download",
    completed: 0,
    total: 0,
    bytesCompleted: 1024,
    bytesTotal: 2048,
    message: "等待执行",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const navigateSpy = vi.fn();

function DownloadHarness() {
  const model = useDownloadTasks();
  latestModel = model;
  return createElement(DownloadsPage, { model, onNavigate: navigateSpy });
}

async function render() {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n },
      createElement(ConfirmContext.Provider, { value: confirmMock }, createElement(DownloadHarness))));
  });
}

function article(id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
  if (!element) throw new Error(`Missing task ${id}`);
  return element;
}

function queryButton(scope: ParentNode, label: string): HTMLButtonElement | null {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label) ?? null;
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const element = queryButton(scope, label);
  if (!element) throw new Error(`Missing button ${label}`);
  return element;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetViewState();
  currentTasks = [];
  revision = 0;
  listeners.clear();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
  commandMock.mockReset();
  commandMock.mockImplementation(async (name, args) => {
    if (name === "list_download_tasks") return snapshot();
    if (name === "set_download_paused") {
      currentTasks = currentTasks.map((item) => item.id === args?.taskId && (item.status === "running" || item.status === "paused")
        ? { ...item, status: args?.paused ? "paused" : "running" }
        : item);
      ++revision;
      return snapshot();
    }
    if (name === "cancel_download_task") {
      currentTasks = currentTasks.map((item, index) => {
        if (item.id === args?.taskId) return { ...item, status: "cancelled" };
        if (index === 1 && item.status === "queued") return { ...item, status: "running" };
        return item;
      });
      ++revision;
      return snapshot();
    }
    if (name === "retry_download_task") {
      currentTasks = [...currentTasks, task({ id: "retry-1", status: "queued", stage: "queued" })];
      ++revision;
      return "retry-1";
    }
    return null;
  });
  eventsMock.mockReset();
  eventsMock.mockImplementation((name, callback) => {
    listeners.set(name, callback);
    return Promise.resolve(() => listeners.delete(name));
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("download task center", () => {
  it("subscribes before reconciling and never revives a completed task from an old response", async () => {
    let bind!: () => void;
    const subscribed = new Promise<void>(resolve => { bind = resolve; });
    eventsMock.mockImplementation((name, callback) => subscribed.then(() => {
      listeners.set(name, callback);
      return () => listeners.delete(name);
    }));
    let latest!: (value: unknown) => void;
    const initial = new Promise(resolve => { latest = resolve; });
    commandMock.mockImplementation(async name => name === "list_download_tasks" ? initial : null);
    await render();
    const requestedTooEarly = commandMock.mock.calls.some(([name]) => name === "list_download_tasks");
    await act(async () => bind());
    const completed = [task({ id: "native-finish", status: "completed", stage: "complete" })];
    const stale = [task({ id: "native-finish", status: "running", stage: "download" })];
    await act(async () => listeners.get("launcher://tasks")?.({ revision: 14, tasks: completed }));
    await act(async () => latest({ revision: 13, tasks: stale }));
    expect(article("native-finish").dataset.status).toBe("completed");
    expect(requestedTooEarly).toBe(false);
  });

  it("rejects an old pause result after the same task finishes by event", async () => {
    currentTasks = [task({ id: "departed" })];
    await render();
    const normal = commandMock.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    const paused = new Promise(resolve => { finish = resolve; });
    commandMock.mockImplementation(async (name, args) => name === "set_download_paused" ? paused : normal(name, args));
    await act(async () => button(article("departed"), "Pause").click());
    const terminal = [{ ...currentTasks[0], status: "completed", stage: "complete" }];
    const obsolete = [{ ...currentTasks[0], status: "paused" }];
    await act(async () => listeners.get("launcher://tasks")?.({ revision: 9, tasks: terminal }));
    await act(async () => finish({ revision: 8, tasks: obsolete }));
    expect(article("departed").dataset.status).toBe("completed");
  });

  it("provides an explicit refresh with an empty history", async () => {
    await render();
    expect(container.textContent).toContain("No download tasks yet");
    currentTasks = [task({ id: "missed-event", status: "completed", stage: "complete" })];
    ++revision;
    await act(async () => button(container, "Refresh").click());
    expect(article("missed-event").dataset.status).toBe("completed");
  });

  it("hides empty character-preview rows while keeping real history rows", async () => {
    currentTasks = [
      task({ id: "server-01", kind: "server-install", target: "1.21.1", stage: "server-jar", label: "安装服务端 绿洲" }),
      task({ id: "skin-empty", kind: "default-skin", target: "alex", stage: "queued", status: "completed", label: "读取 Alex 角色纹理" }),
      task({
        id: "skin-recorded", kind: "default-skin", target: "steve", completed: 1, total: 1,
        bytesCompleted: 0, bytesTotal: 0, stage: "complete", status: "completed", label: "读取 Steve 角色纹理",
      }),
    ];
    await render();
    expect(article("server-01").querySelector("h3")?.textContent).toBe("Server installation: 1.21.1");
    expect(article("server-01").querySelector(".vx-task-row__stage")?.textContent).toBe("Verifying the server JAR");
    expect(container.querySelector('[data-task-id="skin-empty"]')).toBeNull();
    expect(container.querySelector('[data-task-id="skin-recorded"] h3')?.textContent).toBe("Character preview: Steve");
    expect(container.querySelector('[aria-label="1 in history"]')).not.toBeNull();
  });

  it("does not render an empty character-preview row from a raw model snapshot", async () => {
    const skin = task({
      id: "skin-empty", kind: "default-skin", target: "alex", stage: "queued",
      status: "completed", completed: 0, total: 0, label: "读取 Alex 角色纹理",
    });
    const model: DownloadTasksModel = {
      tasks: [skin], active: [], history: [skin], rates: {}, activeCount: 0, busyTaskId: null,
      bulkBusy: false, loading: false, error: null,
      act: vi.fn(async () => {}),
      retryFailed: vi.fn(async () => null),
      clearUnfinished: vi.fn(async () => null),
      refresh: vi.fn(async () => {}),
    };
    const i18n = createLauncherI18n("en-US", "en-US");
    await i18n.initPromise;
    await act(async () => {
      root.render(createElement(I18nextProvider, { i18n },
        createElement(ConfirmContext.Provider, { value: confirmMock }, createElement(DownloadsPage, { model }))));
    });
    expect(container.querySelector('[data-task-id="skin-empty"]')).toBeNull();
    expect(container.textContent).toContain("No download tasks yet");
  });

  it("uses a filename for local imports and does not display an opaque instance ID", async () => {
    currentTasks = [
      task({ id: "local-source", kind: "modpack", target: "C:\\SyntheticFixture\\incoming\\Coast pack.mrpack" }),
      task({ id: "sample-copy", kind: "backup", target: "55349e6e-2571-4a12-bcfc-e337ee5ab6c6", label: "Sky town", status: "completed" }),
    ];
    await render();
    expect(article("local-source").querySelector("h3")?.textContent).toBe("Modpack installation: Coast pack.mrpack");
    expect(article("local-source").textContent).not.toContain("SyntheticFixture");
    expect(article("sample-copy").querySelector("h3")?.textContent).toBe("Instance backup");
    expect(article("sample-copy").textContent).not.toContain("55349e6e");
  });

  it("introduces task content with a page description", async () => {
    await render();
    expect(container.querySelector(".vx-page-header__text p")?.textContent?.trim()).toBeTruthy();
  });
  it("paginates 199 terminal tasks and filters their real status without rendering fictitious progress", async () => {
    currentTasks = [task({ id: "active" }), ...Array.from({ length: 199 }, (_, index) => task({
      id: `history-${index}`, status: index % 2 ? "failed" : "completed", stage: index % 2 ? "failed" : "complete",
      bytesCompleted: 0, bytesTotal: 0, total: 0, completed: index,
    }))];
    await render();
    const history = container.querySelector('.vx-task-section--history')!;
    const rows = () => [...history.querySelectorAll<HTMLElement>('[data-task-id]')];
    expect(latestModel.tasks).toHaveLength(200);
    expect(rows()).toHaveLength(30);
    expect(container.querySelector('[aria-label="199 in history"]')).not.toBeNull();
    expect(history.querySelector(".vx-lattice-progress")).toBeNull();
    expect(history.textContent).not.toContain("Size pending");
    await act(async () => button(history, "Show more").click());
    expect(rows()).toHaveLength(60);
    await act(async () => button(history, "Failed").click());
    expect(rows()).toHaveLength(30);
    expect(rows().every(row => row.dataset.status === "failed")).toBe(true);
    await act(async () => button(history, "Completed").click());
    expect(rows()).toHaveLength(30);
    expect(rows().every(row => row.dataset.status === "completed")).toBe(true);
    expect(article("active").querySelector(".vx-lattice-progress")).not.toBeNull();
    expect(container.querySelector('.vx-task-section--active')?.classList.contains("vx-panel")).toBe(true);
  });
  it("restores history filters and expansion after leaving and returning", async () => {
    currentTasks = Array.from({ length: 80 }, (_, index) => task({
      id: `history-${index}`,
      status: index < 40 ? "completed" : "failed",
      stage: index < 40 ? "complete" : "failed",
      updatedAt: `2026-01-01T00:${String(80 - index).padStart(2, "0")}:00Z`,
    }));
    await render();
    const history = () => container.querySelector<HTMLElement>('.vx-task-section--history')!;
    const rows = () => [...history().querySelectorAll<HTMLElement>('[data-task-id]')];
    expect(rows()).toHaveLength(30);

    await act(async () => button(history(), "Failed").click());
    expect(rows()).toHaveLength(30);
    await act(async () => button(history(), "Show more").click());
    expect(rows()).toHaveLength(40);
    expect(button(history(), "Failed").getAttribute("aria-pressed")).toBe("true");

    await act(async () => root.render(null));
    await render();

    expect(button(history(), "Failed").getAttribute("aria-pressed")).toBe("true");
    expect(rows()).toHaveLength(40);
  });
  it("shows a filter-specific empty state without losing history counts", async () => {
    currentTasks = [task({ id: "done", status: "completed", stage: "complete" })];
    await render();
    const history = container.querySelector('.vx-task-section--history')!;
    await act(async () => button(history, "Failed").click());
    expect(history.querySelectorAll('[data-task-id]')).toHaveLength(0);
    expect(history.textContent).toContain("No matching tasks");
    expect(container.querySelector('[aria-label="1 in history"]')).not.toBeNull();
    await act(async () => button(history, "All").click());
    expect(article("done")).not.toBeNull();
  });
  it("retains prepared groups across page renders and sorts timestamp offsets chronologically", async () => {
    currentTasks = [
      task({ id: "older", status: "completed", updatedAt: "2026-11-03T04:00:00+08:00" }),
      task({ id: "newer", status: "completed", updatedAt: "2026-11-02T22:00:00Z" }),
      task({ id: "queued", status: "queued" }),
      task({ id: "running", status: "running" }),
    ];
    await render();
    expect(latestModel.active?.map(item => item.id)).toEqual(["running", "queued"]);
    expect(latestModel.history?.map(item => item.id)).toEqual(["newer", "older"]);
    const active = latestModel.active, history = latestModel.history;
    await render();
    expect(latestModel.active).toBe(active);
    expect(latestModel.history).toBe(history);
  });
  it("maps every persisted status to an allowed action", () => {
    expect(taskActions("queued")).toEqual(["cancel"]);
    expect(taskActions("running")).toEqual(["pause", "cancel"]);
    expect(taskActions("paused")).toEqual(["resume", "cancel"]);
    // Retry follows the backend's computed flag, whatever the kind.
    expect(taskActions("interrupted", true)).toEqual(["retry"]);
    expect(taskActions("completed", true)).toEqual([]);
    expect(taskActions("failed", true)).toEqual(["retry"]);
    expect(taskActions("cancelled", true)).toEqual(["retry"]);
    expect(taskActions("failed", false)).toEqual([]);
    expect(taskActions("failed")).toEqual([]);
    expect(taskActions("future-status", true)).toEqual([]);
  });

  it("localizes kind, stage and status without showing legacy labels", async () => {
    const statuses = ["running", "queued", "paused", "interrupted", "completed", "failed", "cancelled"];
    currentTasks = statuses.map((status, index) => task({ id: `task-${status}`, status }));
    await render();
    for (const label of ["Downloading", "Queued", "Paused", "Interrupted", "Completed", "Failed", "Cancelled"]) {
      expect(container.textContent).toContain(label);
    }
    expect(container.textContent).toContain("Game installation");
    expect(container.textContent).toContain("Downloading files");
    expect(container.textContent).not.toContain("等待执行");
    expect(container.textContent).not.toContain("Legacy task label");
  });

  it("keeps unknown totals indeterminate and aggregates counts above the cell limit", async () => {
    currentTasks = [
      task({ id: "aggregate", completed: 65, total: 130 }),
      task({ id: "unknown", completed: 12, total: 0, bytesCompleted: 0, bytesTotal: 0 }),
    ];
    await render();
    const aggregate = article("aggregate");
    expect(aggregate.textContent).toContain("65 / 130 files");
    expect(aggregate.textContent).toContain("50%");
    expect(aggregate.textContent).toContain("1 KiB / 2 KiB");
    const aggregateProgress = aggregate.querySelector("canvas.vx-lattice-progress");
    expect(aggregateProgress).not.toBeNull();
    expect(aggregateProgress?.getAttribute("data-unit")).toBe("bytes");
    expect(aggregateProgress?.getAttribute("role")).toBe("progressbar");
    expect(aggregateProgress?.getAttribute("aria-valuenow")).toBe("1024");
    expect(aggregateProgress?.getAttribute("aria-valuemax")).toBe("2048");
    const unknown = article("unknown");
    expect(unknown.textContent).toContain("12 files, total unknown");
    expect(unknown.textContent).not.toContain("%");
    expect(unknown.textContent).toContain("Size pending");
    const unknownProgress = unknown.querySelector("canvas.vx-lattice-progress");
    expect(unknownProgress).not.toBeNull();
    expect(unknownProgress?.getAttribute("data-determinate")).toBe("false");
    expect(unknownProgress?.hasAttribute("aria-valuenow")).toBe(false);
  });

  it("makes the real stage prominent without duplicating status decoration", async () => {
    currentTasks = [task({ id: "stage", status: "running", stage: "download" })];
    await render();
    const row = article("stage");
    expect(row.dataset.stage).toBe("download");
    expect(row.classList.contains("vx-task-row")).toBe(true);
    expect(row.querySelector(".vx-task-row__stage")?.textContent).toContain("Downloading files");
    expect(row.querySelector(".vx-task-row__status")).toBeNull();
    expect(row.querySelectorAll(".vx-task-row__stage svg")).toHaveLength(1);
    expect(row.querySelector(".vx-task-row__progress .vx-lattice-progress")).not.toBeNull();
    expect(container.querySelector(".vx-task-center")).not.toBeNull();
    expect(container.querySelector(".vx-task-card")).toBeNull();
  });

  it("pauses, resumes and cancels the selected task while the next task starts", async () => {
    currentTasks = [
      task({ id: "active", target: "1.21.1" }),
      task({ id: "next", target: "1.20.1", status: "queued", stage: "queued" }),
    ];
    await render();
    await act(async () => button(article("active"), "Pause").click());
    expect(commandMock).toHaveBeenCalledWith("set_download_paused", { taskId: "active", paused: true });
    expect(article("active").textContent).toContain("Paused");
    await act(async () => button(article("active"), "Resume").click());
    expect(commandMock).toHaveBeenCalledWith("set_download_paused", { taskId: "active", paused: false });
    await act(async () => button(article("active"), "Cancel").click());
    expect(commandMock).toHaveBeenCalledWith("cancel_download_task", { taskId: "active" });
    expect(commandMock).not.toHaveBeenCalledWith("cancel_download_task", { taskId: null });
    expect(article("next").textContent).toContain("Downloading");
  });

  it("retries only recoverable installation history and refreshes the shared list", async () => {
    currentTasks = [
      task({ id: "failed-install", status: "failed", stage: "failed", retryable: true }),
      task({ id: "failed-resource", kind: "resource", status: "failed", stage: "failed", retryable: false }),
      task({ id: "completed", status: "completed", stage: "complete" }),
    ];
    await render();
    expect(article("failed-resource").querySelectorAll("button")).toHaveLength(0);
    expect(article("completed").querySelectorAll("button")).toHaveLength(0);
    commandMock.mockClear();
    await act(async () => button(article("failed-install"), "Retry").click());
    expect(commandMock).toHaveBeenCalledWith("retry_download_task", { taskId: "failed-install" });
    expect(commandMock).toHaveBeenCalledWith("list_download_tasks");
    expect(article("retry-1").textContent).toContain("Queued");
  });

  it("derives rate only from two real byte snapshots", async () => {
    currentTasks = [task({ id: "rate", bytesCompleted: 1024 })];
    await render();
    expect(article("rate").textContent).not.toContain("/s");
    currentTasks = [task({
      id: "rate",
      bytesCompleted: 2048,
      updatedAt: "2026-01-01T00:00:02Z",
    })];
    await act(async () => listeners.get("launcher://tasks")?.({ revision: ++revision, tasks: currentTasks }));
    expect(article("rate").textContent).toContain("512 B/s");
  });

  it("uses one purposeful empty state when no tasks exist", async () => {
    await render();
    expect(container.textContent).toContain("No download tasks yet");
    expect(container.querySelectorAll(".vx-empty")).toHaveLength(1);
  });

  it("leads an empty task center to Discover or to installing a game version", async () => {
    navigateSpy.mockReset();
    await render();
    const empty = container.querySelector<HTMLElement>(".vx-downloads-empty.vx-empty--panel");
    expect(empty).not.toBeNull();
    expect(empty!.querySelector(".vx-empty__icon.vx-icon-tile svg")).not.toBeNull();
    const browse = button(empty!, "Browse content");
    const install = button(empty!, "Install a game version");
    expect(browse.dataset.variant).toBe("primary");
    expect(install.dataset.variant).toBe("ghost");
    await act(async () => browse.click());
    await act(async () => install.click());
    expect(navigateSpy.mock.calls).toEqual([["discover"], ["library"]]);
  });

  it("refreshes from a labelled icon button in the page header", async () => {
    await render();
    const refresh = container.querySelector<HTMLButtonElement>(".vx-page-header__actions button");
    expect(refresh?.classList.contains("vx-button--icon")).toBe(true);
    expect(refresh?.getAttribute("aria-label")).toBe("Refresh");
    expect(refresh?.getAttribute("title")).toBe("Refresh");
  });

  it("uses the shared inline empty state for an idle active section", async () => {
    currentTasks = [task({ id: "done", status: "completed", stage: "complete" })];
    await render();
    const active = container.querySelector(".vx-task-section--active")!;
    expect(active.querySelector(".vx-empty--inline")?.textContent).toContain("No active tasks");
    expect(container.querySelector(".vx-task-section__empty")).toBeNull();
  });

  it("offers Retry for any kind the backend marks retryable, and explains a second retry", async () => {
    currentTasks = [
      task({ id: "failed-loader", kind: "loader", target: "1.20.1", status: "failed", stage: "failed", retryable: true }),
      task({ id: "failed-pack", kind: "modpack", target: "pack", status: "interrupted", stage: "interrupted", retryable: true }),
      task({ id: "failed-export", kind: "export", status: "failed", stage: "failed", retryable: false }),
    ];
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_download_tasks") return snapshot();
      if (name === "retry_download_task" && (args as { taskId: string }).taskId === "failed-pack") throw new LauncherError("download.alreadyRetried");
      if (name === "retry_download_task") return "retry-loader";
      return null;
    });
    await render();
    expect(article("failed-export").querySelectorAll("button")).toHaveLength(0);
    await act(async () => button(article("failed-loader"), "Retry").click());
    expect(commandMock).toHaveBeenCalledWith("retry_download_task", { taskId: "failed-loader" });
    await act(async () => button(article("failed-pack"), "Retry").click());
    expect(container.textContent).toContain("This task was already retried. Use the newer task instead.");
  });

  it("suggests retrying an interrupted task only when it can be retried", async () => {
    currentTasks = [
      task({ id: "again", kind: "loader", status: "interrupted", stage: "interrupted", retryable: true }),
      task({ id: "final", kind: "export", status: "interrupted", stage: "interrupted", retryable: false }),
    ];
    // History rows are compact; the full row is the one that carries the description.
    const i18n = createLauncherI18n("en-US", "en-US");
    await i18n.initPromise;
    await act(async () => {
      root.render(createElement(I18nextProvider, { i18n }, createElement(TaskList, {
        tasks: currentTasks, rates: {}, busyTaskId: null, onAction: () => undefined,
      })));
    });
    expect(article("again").querySelector(".vx-task-row__message")?.textContent).toBe("The launcher closed before this task finished. Retry to reuse verified files.");
    expect(article("final").querySelector(".vx-task-row__message")?.textContent).toBe("The launcher closed before this task finished.");
  });

  it("shows a localized expected error when a retry target no longer exists", async () => {
    currentTasks = [task({ id: "missing", status: "failed", stage: "failed", retryable: true })];
    commandMock.mockImplementation(async (name) => {
      if (name === "list_download_tasks") return snapshot();
      if (name === "retry_download_task") throw new LauncherError("download.notFound");
      return null;
    });
    await render();
    await act(async () => button(article("missing"), "Retry").click());
    expect(container.textContent).toContain("This task no longer exists. Refresh and try again.");
    expect(container.textContent).not.toContain("Something went wrong");
  });

  it("offers bulk retry and clear only for the history tasks they apply to", async () => {
    currentTasks = [
      task({ id: "finished", status: "completed", stage: "complete" }),
      task({ id: "failed-final", status: "failed", stage: "failed", retryable: false }),
    ];
    await render();
    const history = () => container.querySelector<HTMLElement>(".vx-task-section--history")!;
    expect(queryButton(history(), "Retry failed")).toBeNull();
    expect(queryButton(history(), "Clear failed and cancelled")).not.toBeNull();

    currentTasks = [
      ...currentTasks,
      task({ id: "failed-again", status: "failed", stage: "failed", retryable: true }),
      task({ id: "cancelled", status: "cancelled", stage: "cancelled", retryable: true }),
    ];
    await act(async () => listeners.get("launcher://tasks")?.({ revision: ++revision, tasks: currentTasks }));
    expect(queryButton(history(), "Retry failed")).not.toBeNull();
    expect(queryButton(history(), "Clear failed and cancelled")).not.toBeNull();

    currentTasks = [task({ id: "only-cancelled", status: "cancelled", stage: "cancelled" })];
    await act(async () => listeners.get("launcher://tasks")?.({ revision: ++revision, tasks: currentTasks }));
    expect(queryButton(history(), "Retry failed")).toBeNull();
    expect(queryButton(history(), "Clear failed and cancelled")).not.toBeNull();
  });

  it("retries every failed task in one bulk action and reports the counts", async () => {
    currentTasks = [
      task({ id: "failed-a", status: "failed", stage: "failed", retryable: true }),
      task({ id: "failed-b", status: "failed", stage: "failed", retryable: true }),
      task({ id: "finished", status: "completed", stage: "complete" }),
    ];
    await render();
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "retry_failed_downloads") return { ids: ["bulk-1", "bulk-2"], skipped: 1 };
      return normal(name, args);
    });
    commandMock.mockClear();
    await act(async () => button(container.querySelector(".vx-task-section--history")!, "Retry failed").click());
    expect(commandMock).toHaveBeenCalledWith("retry_failed_downloads");
    expect(commandMock).toHaveBeenCalledWith("list_download_tasks");
    expect(container.textContent).toContain("Queued 2 tasks");
    expect(container.textContent).toContain("1 skipped");
    expect(container.querySelector(".vx-downloads-notice")?.textContent).not.toBe("");
  });

  it("asks before clearing failed and cancelled history and reports the bytes freed", async () => {
    currentTasks = [
      task({ id: "failed-clear", status: "failed", stage: "failed" }),
      task({ id: "cancelled-clear", status: "cancelled", stage: "cancelled" }),
      task({ id: "kept", status: "completed", stage: "complete" }),
    ];
    await render();
    const history = () => container.querySelector<HTMLElement>(".vx-task-section--history")!;
    confirmMock.mockResolvedValueOnce(false);
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "clear_unfinished_downloads") {
        currentTasks = currentTasks.filter(item => item.status !== "failed" && item.status !== "cancelled");
        ++revision;
        return { tasks: 2, bytes: 2048 };
      }
      return normal(name, args);
    });
    await act(async () => button(history(), "Clear failed and cancelled").click());
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(String(confirmMock.mock.calls[0][0])).toContain("2");
    expect(confirmMock.mock.calls[0][1]).toMatchObject({ tone: "danger" });
    expect(commandMock).not.toHaveBeenCalledWith("clear_unfinished_downloads");

    confirmMock.mockResolvedValue(true);
    await act(async () => button(history(), "Clear failed and cancelled").click());
    expect(commandMock).toHaveBeenCalledWith("clear_unfinished_downloads");
    expect(container.textContent).toContain("Removed 2 tasks");
    expect(container.textContent).toContain("2 KiB");
    expect(queryButton(history(), "Clear failed and cancelled")).toBeNull();
  });

  it("shows a bulk clear refusal through the existing error display", async () => {
    currentTasks = [task({ id: "failed-busy", status: "failed", stage: "failed" })];
    await render();
    commandMock.mockImplementation(async (name) => {
      if (name === "list_download_tasks") return snapshot();
      if (name === "clear_unfinished_downloads") throw new LauncherError("download.busy");
      return null;
    });
    await act(async () => button(container.querySelector(".vx-task-section--history")!, "Clear failed and cancelled").click());
    expect(container.textContent).toContain("A download is still running or queued. Wait for it to finish before clearing.");
    expect(container.querySelector(".vx-downloads-error")).not.toBeNull();
  });
});
