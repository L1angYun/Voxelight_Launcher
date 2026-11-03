// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { command, events } from "../../lib/launcher";
import { LauncherError } from "../../lib/errors";
import { createLauncherI18n } from "../../i18n";
import { DownloadsPage } from "./DownloadsPage";
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
let latestModel: DownloadTasksModel;

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  events: vi.fn(),
}));

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

function DownloadHarness() {
  const model = useDownloadTasks();
  latestModel = model;
  return createElement(DownloadsPage, { model });
}

async function render() {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n }, createElement(DownloadHarness)));
  });
}

function article(id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
  if (!element) throw new Error(`Missing task ${id}`);
  return element;
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const element = Array.from(scope.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!element) throw new Error(`Missing button ${label}`);
  return element;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  currentTasks = [];
  listeners.clear();
  commandMock.mockReset();
  commandMock.mockImplementation(async (name, args) => {
    if (name === "list_download_tasks") return currentTasks;
    if (name === "set_download_paused") {
      currentTasks = currentTasks.map((item) => item.status === "running" || item.status === "paused"
        ? { ...item, status: args?.paused ? "paused" : "running" }
        : item);
      return currentTasks;
    }
    if (name === "cancel_download_task") {
      currentTasks = currentTasks.map((item, index) => {
        if (item.id === args?.taskId) return { ...item, status: "cancelled" };
        if (index === 1 && item.status === "queued") return { ...item, status: "running" };
        return item;
      });
      return currentTasks;
    }
    if (name === "retry_download_task") {
      currentTasks = [...currentTasks, task({ id: "retry-1", status: "queued", stage: "queued" })];
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
  vi.clearAllMocks();
});

describe("download task center", () => {
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
    expect(taskActions("interrupted")).toEqual(["retry"]);
    expect(taskActions("completed")).toEqual([]);
    expect(taskActions("failed")).toContain("retry");
    expect(taskActions("cancelled")).toEqual(["retry"]);
    expect(taskActions("failed", "resource")).toEqual([]);
    expect(taskActions("future-status")).toEqual([]);
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
    expect(unknown.textContent).toContain("12 files · total unknown");
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
    expect(commandMock).toHaveBeenCalledWith("set_download_paused", { paused: true });
    expect(article("active").textContent).toContain("Paused");
    await act(async () => button(article("active"), "Resume").click());
    expect(commandMock).toHaveBeenCalledWith("set_download_paused", { paused: false });
    await act(async () => button(article("active"), "Cancel").click());
    expect(commandMock).toHaveBeenCalledWith("cancel_download_task", { taskId: "active" });
    expect(commandMock).not.toHaveBeenCalledWith("cancel_download_task", { taskId: null });
    expect(article("next").textContent).toContain("Downloading");
  });

  it("retries only recoverable installation history and refreshes the shared list", async () => {
    currentTasks = [
      task({ id: "failed-install", status: "failed", stage: "failed" }),
      task({ id: "failed-resource", kind: "resource", status: "failed", stage: "failed" }),
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
    await act(async () => listeners.get("launcher://tasks")?.(currentTasks));
    expect(article("rate").textContent).toContain("512 B/s");
  });

  it("uses one purposeful empty state when no tasks exist", async () => {
    await render();
    expect(container.textContent).toContain("No download tasks yet");
    expect(container.querySelectorAll(".vx-empty")).toHaveLength(1);
  });

  it("shows a localized expected error when a retry target no longer exists", async () => {
    currentTasks = [task({ id: "missing", status: "failed", stage: "failed" })];
    commandMock.mockImplementation(async (name) => {
      if (name === "list_download_tasks") return currentTasks;
      if (name === "retry_download_task") throw new LauncherError("download.notFound");
      return null;
    });
    await render();
    await act(async () => button(article("missing"), "Retry").click());
    expect(container.textContent).toContain("This task no longer exists. Refresh and try again.");
    expect(container.textContent).not.toContain("Something went wrong");
  });
});
