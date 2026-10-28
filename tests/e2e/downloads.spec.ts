import { expect, test, type Page } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";
import type { DownloadTask } from "../../src/features/downloads/useDownloadTasks";

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: "task-active",
    kind: "install",
    target: "1.21.1",
    label: "Legacy task label",
    status: "running",
    stage: "download",
    completed: 65,
    total: 130,
    bytesCompleted: 1024,
    bytesTotal: 2048,
    message: "等待执行",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    ...overrides,
  };
}

function mockTasks(page: Page, initialTasks: DownloadTask[]) {
  return page.addInitScript((initial) => {
    let tasks = initial;
    const snapshot = () => tasks.map((item) => ({ ...item }));
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args) => {
      const record = (result: unknown) => {
        (window as unknown as {
          __appearanceFixtures: {
            calls: { name: string; args?: Record<string, unknown> }[];
          };
        }).__appearanceFixtures.calls.push({ name, args });
        return result;
      };
      if (name === "list_download_tasks") return record(snapshot());
      if (name === "set_download_paused") {
        tasks = tasks.map((item) => item.status === "running" || item.status === "paused"
          ? { ...item, status: args?.paused ? "paused" : "running" }
          : item);
        return record(snapshot());
      }
      if (name === "cancel_download_task") {
        const cancellingActive = tasks.some((item) => item.id === args?.taskId && item.status === "running");
        tasks = tasks.map((item) => item.id === args?.taskId
          ? { ...item, status: "cancelled", stage: "cancelled" }
          : item);
        if (cancellingActive) {
          const next = tasks.findIndex((item) => item.status === "queued");
          if (next >= 0) tasks[next] = { ...tasks[next], status: "running", stage: "download" };
        }
        return record(snapshot());
      }
      if (name === "retry_download_task") {
        const source = tasks.find((item) => item.id === args?.taskId);
        tasks = [...tasks, {
          ...(source ?? initial[0]),
          id: "retry-1",
          status: "queued",
          stage: "queued",
          completed: 0,
          total: 0,
        }];
        return record("retry-1");
      }
      return original(name, args);
    };
  }, initialTasks);
}

async function openDownloads(page: Page) {
  await page.goto("/?next-ui");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^下载/ }).click();
  await expect(page.getByRole("heading", { name: "下载", exact: true })).toBeVisible();
}

test("task progress, pause and resume use the same task snapshot", async ({ page }) => {
  await installLauncherFixture(page);
  await mockTasks(page, [
    task({}),
    task({ id: "task-complete", status: "completed", stage: "complete", completed: 10, total: 10 }),
  ]);
  await openDownloads(page);
  const card = page.locator('[data-task-id="task-active"]');
  await expect(card).toContainText("65 / 130 个文件");
  await expect(card).toContainText("50%");
  await expect(card.locator("canvas.vx-lattice-progress")).toHaveCount(1);
  await expect(page.getByText("等待执行", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Legacy task label", { exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: /^暂停:/ }).click();
  await expect(card).toContainText("已暂停");
  await card.getByRole("button", { name: /^继续:/ }).click();
  await expect(card).toContainText("正在下载");
});

test("cancelling the active task starts the next queued task", async ({ page }) => {
  await installLauncherFixture(page);
  await mockTasks(page, [
    task({}),
    task({ id: "task-next", target: "1.20.1", status: "queued", stage: "queued", completed: 0, total: 0 }),
  ]);
  await openDownloads(page);
  await page.locator('[data-task-id="task-active"]').getByRole("button", { name: /^取消:/ }).click();
  await expect(page.locator('[data-task-id="task-active"]')).toContainText("已取消");
  await expect(page.locator('[data-task-id="task-next"]')).toContainText("正在下载");
  const calls = await page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
  }).__appearanceFixtures.calls);
  expect(calls.some((call) => call.name === "cancel_download_task" && call.args?.taskId === "task-active")).toBe(true);
  expect(calls.some((call) => call.name === "cancel_download_task" && call.args?.taskId === null)).toBe(false);
});

test("failed installations retry while unsupported history stays read-only", async ({ page }) => {
  await installLauncherFixture(page);
  await mockTasks(page, [
    task({ id: "failed-install", status: "failed", stage: "failed" }),
    task({ id: "failed-resource", kind: "resource", target: "sodium", status: "failed", stage: "failed" }),
    task({ id: "completed", status: "completed", stage: "complete" }),
  ]);
  await openDownloads(page);
  await expect(page.locator('[data-task-id="failed-resource"]').getByRole("button")).toHaveCount(0);
  await expect(page.locator('[data-task-id="completed"]').getByRole("button")).toHaveCount(0);
  await page.locator('[data-task-id="failed-install"]').getByRole("button", { name: /^重试:/ }).click();
  await expect(page.locator('[data-task-id="retry-1"]')).toContainText("排队中");
  const calls = await page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
  }).__appearanceFixtures.calls);
  expect(calls.some((call) => call.name === "retry_download_task" && call.args?.taskId === "failed-install")).toBe(true);
});
