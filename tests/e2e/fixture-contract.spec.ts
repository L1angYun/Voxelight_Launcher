import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

test("M10 fixture rejects unnamed IPC commands instead of pretending they succeeded", async ({ page }) => {
  await page.route("http://fixture.local/", (route) => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>IPC fixture only</title>",
  }));
  await installLauncherFixture(page);
  await page.goto("http://fixture.local/");
  const outcome = await page.evaluate(async () => {
    const { invoke } = (window as unknown as {
      __TAURI_INTERNALS__: { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> };
    }).__TAURI_INTERNALS__;
    async function unhandled(name: string) {
      try {
        await invoke(name);
        return "resolved";
      } catch (error) {
        return String(error);
      }
    }
    return {
      existingEmpty: await invoke("list_worlds", { versionId: "1.21.1" }),
      unrecognizedQuery: await unhandled("list_unknown_fixture_probe"),
      unrecognizedAction: await unhandled("unknown_fixture_probe"),
    };
  });
  expect(outcome.existingEmpty).toEqual([]);
  expect(outcome.unrecognizedQuery).toContain("Unhandled launcher fixture IPC: list_unknown_fixture_probe");
  expect(outcome.unrecognizedAction).toContain("Unhandled launcher fixture IPC: unknown_fixture_probe");
});

test("M10 fixture shares an event between independent subscribers and unlistens one by ID", async ({ page }) => {
  await page.route("http://fixture.local/", (route) => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>IPC fixture only</title>",
  }));
  await installLauncherFixture(page);
  await page.goto("http://fixture.local/");
  const observed = await page.evaluate(async () => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: {
        transformCallback(cb: (event: unknown) => void): number;
        invoke(name: string, args?: Record<string, unknown>): Promise<unknown>;
      };
    }).__TAURI_INTERNALS__;
    const event = "launcher://tasks";
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    const one = await internals.invoke("plugin:event|listen", { event, handler: internals.transformCallback((entry) => firstEvents.push(entry)) });
    const two = await internals.invoke("plugin:event|listen", { event, handler: internals.transformCallback((entry) => secondEvents.push(entry)) });
    await internals.invoke("reserve_launch_task", { versionId: "1.21.1" });
    await internals.invoke("plugin:event|unlisten", { event, eventId: two });
    await internals.invoke("reserve_launch_task", { versionId: "1.21.1" });
    return { distinctIds: one !== two, first: firstEvents.length, second: secondEvents.length };
  });
  expect(observed).toEqual({ distinctIds: true, first: 2, second: 1 });
});
