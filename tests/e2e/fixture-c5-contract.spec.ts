import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.route("http://fixture.local/", (route) => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>IPC fixture only</title>",
  }));
  await installLauncherFixture(page, { launchDelay: 0 });
  await page.goto("http://fixture.local/");
});

test("M10 fixture honors native picker purpose and the confirmed export preview", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const { invoke } = (window as unknown as {
      __TAURI_INTERNALS__: { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const instanceId = "fixture-world", options = { includeConfigs: false };
    const paths = await invoke("choose_launcher_path", { purpose: "packWrite", suggestedName: "world.mrpack" }) as string[];
    const preview = await invoke("plan_modrinth_export", { instanceId, options }) as {
      bundledFiles: string[]; fingerprint: string;
    };
    const outputPath = paths[0];
    const failure = await invoke("export_modrinth_modpack", { instanceId, outputPath, options, confirmedFingerprint: "stale" })
      .then(() => "resolved", (error: unknown) => error);
    const result = await invoke("export_modrinth_modpack", { instanceId, outputPath, options, confirmedFingerprint: preview.fingerprint });
    return { paths, included: preview.bundledFiles, failure, result };
  });
  const path = "C:\\SyntheticFixture\\fixture-pack.mrpack";
  expect(outcome).toEqual({ paths: [path], included: ["modrinth.index.json"], failure: { code: "instance.exportPreviewChanged", params: {}, detail: "instance.exportPreviewChanged" },
    result: { path, downloadFiles: 1, overrideFiles: 0, warnings: [] } });
});

test("M10 fixture normal stop and exit event refer to the same owned game ID", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const ipc = (window as unknown as { __TAURI_INTERNALS__: {
      invoke(name: string, args?: Record<string, unknown>): Promise<unknown>;
      transformCallback(fn: (event: { payload: unknown }) => void): number;
    } }).__TAURI_INTERNALS__;
    const versionId = "1.21.1";
    const taskId = await ipc.invoke("reserve_launch_task", { versionId });
    const game = await ipc.invoke("launch_game", { versionId, taskId }) as { gameId: string; pid: number };
    const initial = await ipc.invoke("list_running_games") as typeof game[];
    const event = "launcher://game-exit";
    let gotExit: unknown;
    await ipc.invoke("plugin:event|listen", { event, handler: ipc.transformCallback(({ payload }) => { gotExit = payload; }) });
    const result = await ipc.invoke("stop_game", { gameId: game.gameId, force: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    return { game, visible: initial.map(row => row.gameId), result, after: await ipc.invoke("list_running_games"), gotExit };
  });
  expect(outcome.visible).toEqual([outcome.game.gameId]);
  expect(outcome.game.gameId).toBeTruthy();
  expect(outcome.result).toEqual({ status: "stopped" });
  expect(outcome.after).toEqual([]);
  expect(outcome.gotExit).toEqual({ gameId: outcome.game.gameId, pid: outcome.game.pid, code: 0 });
});
