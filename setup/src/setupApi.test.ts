// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPreviewSetupBridge,
  PREVIEW_INSTALL_DURATION_MS,
  PREVIEW_INSTALL_STEP_MS,
  previewInstallProgress,
  type InstallProgress,
} from "./setupApi";

const installDir = "C:\\Users\\User\\AppData\\Local\\Voxelight Launcher";

afterEach(() => {
  vi.useRealTimers();
});

describe("preview install progress", () => {
  it("moves through extract, install and verify on one 0..1000 scale", () => {
    expect(previewInstallProgress(0)).toMatchObject({
      phase: "extract",
      completed: 0,
      total: 1000,
      indeterminate: false,
    });
    expect(previewInstallProgress(1200)).toMatchObject({ phase: "install", completed: 150 });
    expect(previewInstallProgress(4000)).toMatchObject({ phase: "verify", completed: 920 });
    expect(previewInstallProgress(PREVIEW_INSTALL_DURATION_MS)).toMatchObject({
      phase: "verify",
      completed: 1000,
    });
    const halfway = previewInstallProgress(2600);
    expect(halfway.phase).toBe("install");
    expect(halfway.completed).toBeGreaterThan(150);
    expect(halfway.completed).toBeLessThan(920);
    expect(halfway.bytesWritten).toBeGreaterThan(0);
  });
});

describe("preview setup bridge", () => {
  it("reports fake phases over a few seconds and then resolves the install", async () => {
    vi.useFakeTimers();
    const bridge = createPreviewSetupBridge();
    const updates: InstallProgress[] = [];
    await bridge.onInstallProgress((progress) => updates.push(progress));

    let settled = false;
    const install = bridge.startInstall({ installDir, createShortcuts: true }).then((outcome) => {
      settled = true;
      return outcome;
    });

    await vi.advanceTimersByTimeAsync(PREVIEW_INSTALL_STEP_MS * 5);
    expect(updates.at(-1)?.phase).toBe("extract");
    expect(updates.at(-1)?.completed).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(1500);
    expect(updates.at(-1)?.phase).toBe("install");
    expect(updates.at(-1)?.bytesWritten).toBeGreaterThan(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2500);
    expect(updates.at(-1)?.phase).toBe("verify");
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(PREVIEW_INSTALL_DURATION_MS);
    const outcome = await install;
    expect(outcome.installDir).toBe(installDir);
    expect(updates.at(-1)?.completed).toBe(1000);
    expect(new Set(updates.map((progress) => progress.phase))).toEqual(
      new Set(["extract", "install", "verify"]),
    );
  });

  it("rejects a second install while the preview run is active", async () => {
    vi.useFakeTimers();
    const bridge = createPreviewSetupBridge();
    const first = bridge.startInstall({ installDir, createShortcuts: true });
    await expect(
      bridge.startInstall({ installDir, createShortcuts: true }),
    ).rejects.toMatchObject({ code: "alreadyInstalling" });
    await vi.advanceTimersByTimeAsync(PREVIEW_INSTALL_DURATION_MS);
    await first;
  });
});
