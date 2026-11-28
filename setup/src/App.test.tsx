// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupApp } from "./App";
import { SETUP_LOCALES, resolveSetupLocale } from "./i18n";
import type {
  InstallFailure,
  InstallOutcome,
  InstallProgress,
  InstallRequest,
  PathValidation,
  SetupBootstrap,
  SetupBridge,
  SystemAppearance,
} from "./setupApi";

interface Harness {
  bridge: SetupBridge;
  emitProgress: (progress: InstallProgress) => void;
  emitAppearance: (appearance: SystemAppearance) => void;
  startInstallMock: ReturnType<typeof vi.fn<(req: InstallRequest) => Promise<InstallOutcome>>>;
  validateMock: ReturnType<typeof vi.fn<(path: string) => Promise<PathValidation>>>;
  pickDirMock: ReturnType<typeof vi.fn<(dir?: string) => Promise<string | null>>>;
  launchMock: ReturnType<typeof vi.fn<() => Promise<void>>>;
  classicMock: ReturnType<typeof vi.fn<() => Promise<void>>>;
  closeMock: ReturnType<typeof vi.fn<() => Promise<void>>>;
  minimizeMock: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function defaultBootstrap(overrides?: Partial<SetupBootstrap>): SetupBootstrap {
  const defaultDir = "C:\\Users\\User\\AppData\\Local\\Voxelight Launcher";
  return {
    version: "0.7.0-beta.2",
    appearance: {
      theme: "dark",
      accentColor: "#ee9ec5",
      animationsEnabled: true,
      advancedEffectsEnabled: true,
      locale: "en-US",
    },
    detected: {
      relation: { kind: "fresh" },
      installDir: defaultDir,
      isExisting: false,
      pathLocked: false,
    },
    validation: {
      valid: true,
      normalizedPath: defaultDir,
      errorCode: null,
      availableBytes: 80 * 1024 * 1024 * 1024,
      requiredBytes: 68 * 1024 * 1024,
    },
    expectedInstallBytes: 36 * 1024 * 1024,
    launchAvailable: true,
    ...overrides,
  };
}

function createHarness(bootstrap: SetupBootstrap = defaultBootstrap()): Harness {
  let progressHandler: ((progress: InstallProgress) => void) | null = null;
  let appearanceHandler: ((appearance: SystemAppearance) => void) | null = null;

  const startInstallMock = vi.fn<(req: InstallRequest) => Promise<InstallOutcome>>(
    async (req) => ({
      installDir: req.installDir,
      executablePath: `${req.installDir}\\voxelight-launcher.exe`,
    }),
  );
  const validateMock = vi.fn<(path: string) => Promise<PathValidation>>(async (path) => ({
    valid: true,
    normalizedPath: path,
    errorCode: null,
    availableBytes: 80 * 1024 * 1024 * 1024,
    requiredBytes: 68 * 1024 * 1024,
  }));
  const pickDirMock = vi.fn<(dir?: string) => Promise<string | null>>(async () => null);
  const launchMock = vi.fn<() => Promise<void>>(async () => {});
  const classicMock = vi.fn<() => Promise<void>>(async () => {});
  const closeMock = vi.fn<() => Promise<void>>(async () => {});
  const minimizeMock = vi.fn<() => Promise<void>>(async () => {});

  const bridge: SetupBridge = {
    getSetupState: vi.fn(async () => bootstrap),
    getLicenseText: vi.fn(async () => "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007"),
    validateInstallPath: validateMock,
    pickInstallDirectory: pickDirMock,
    startInstall: startInstallMock,
    openClassicInstaller: classicMock,
    launchInstalled: launchMock,
    minimizeWindow: minimizeMock,
    closeWindow: closeMock,
    onInstallProgress: vi.fn(async (handler) => {
      progressHandler = handler;
      return () => {
        progressHandler = null;
      };
    }),
    onAppearanceChange: vi.fn(async (handler) => {
      appearanceHandler = handler;
      return () => {
        appearanceHandler = null;
      };
    }),
  };

  return {
    bridge,
    emitProgress: (progress) => progressHandler?.(progress),
    emitAppearance: (appearance) => appearanceHandler?.(appearance),
    startInstallMock,
    validateMock,
    pickDirMock,
    launchMock,
    classicMock,
    closeMock,
    minimizeMock,
  };
}

describe("Voxelight Setup UI", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.documentElement.removeAttribute("lang");
    document.documentElement.removeAttribute("style");
    for (const key of Object.keys(document.documentElement.dataset)) {
      delete document.documentElement.dataset[key];
    }
  });

  async function mount(harness: Harness) {
    await act(async () => {
      root.render(<SetupApp bridge={harness.bridge} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function buttonByText(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((btn) =>
      btn.textContent?.includes(label),
    );
    expect(found, `Expected button containing "${label}"`).toBeTruthy();
    return found!;
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("walks through Welcome, GPL-3.0 dialog, Location, Options, Installing, and Done", async () => {
    let resolveInstall!: (outcome: InstallOutcome) => void;
    const harness = createHarness();
    harness.pickDirMock.mockResolvedValue("D:\\Games\\Voxelight Launcher");
    harness.startInstallMock.mockImplementation(
      () => new Promise<InstallOutcome>((resolve) => {
        resolveInstall = resolve;
      }),
    );

    await mount(harness);

    // Welcome step applies Windows accent and theme.
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#ee9ec5");
    expect(container.querySelector("h1")?.textContent).toBe("Install Voxelight Launcher");
    expect(container.textContent).toContain("0.7.0-beta.2");
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);

    // Open GPL-3.0 license dialog (informational only, no acceptance checkbox).
    const licenseButton = buttonByText("View GPL-3.0 license");
    await click(licenseButton);
    const dialog = container.querySelector<HTMLDialogElement>("dialog.vx-setup-license-dialog")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.textContent).toContain("GNU GENERAL PUBLIC LICENSE");
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog.hasAttribute("open")).toBe(false);

    // Advance to Location and use Browse.
    await click(buttonByText("Continue"));
    expect(container.querySelector("h1")?.textContent).toBe("Install location");
    await click(buttonByText("Browse"));
    const input = container.querySelector<HTMLInputElement>("input[type='text']")!;
    expect(input.value).toBe("D:\\Games\\Voxelight Launcher");
    expect(harness.validateMock).toHaveBeenCalledWith("D:\\Games\\Voxelight Launcher");

    // Advance to Options, uncheck shortcuts and auto-launch.
    await click(buttonByText("Continue"));
    expect(container.querySelector("h1")?.textContent).toBe("Installation options");
    const checkboxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    expect(checkboxes).toHaveLength(2);
    expect(container.querySelector(".vx-setup-summary")).not.toBeNull();
    expect(container.textContent).toContain("Action: Fresh installation of 0.7.0-beta.2");
    expect(container.textContent).not.toMatch(/\/NS\b/);
    await click(checkboxes[0]);
    await click(checkboxes[1]);

    // Begin Installing.
    await click(buttonByText("Install"));
    expect(container.querySelector("h1")?.textContent).toBe("Installing Voxelight");
    expect(harness.startInstallMock).toHaveBeenCalledWith({
      installDir: "D:\\Games\\Voxelight Launcher",
      createShortcuts: false,
    });

    // No Cancel button during install, and window Close button is disabled.
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((text) => /cancel/i.test(text))).toBe(false);
    const closeChrome = container.querySelector<HTMLButtonElement>(".vx-setup-chrome__close")!;
    expect(closeChrome.disabled).toBe(true);

    // Progress updates advance real phases on LatticeProgress.
    const progressbar = container.querySelector('[role="progressbar"]');
    expect(progressbar).not.toBeNull();
    await act(async () => {
      harness.emitProgress({
        phase: "install",
        completed: 520,
        total: 1000,
        indeterminate: false,
        bytesWritten: 18 * 1024 * 1024,
        expectedBytes: 36 * 1024 * 1024,
      });
    });
    expect(container.textContent).toContain("18.0 MB of 36.0 MB written");
    expect(container.querySelector('.vx-setup-phase[data-state="active"]')?.textContent).toBe("Install");

    // Finish installation -> Done step (auto-launch was unchecked).
    await act(async () => {
      resolveInstall({
        installDir: "D:\\Games\\Voxelight Launcher",
        executablePath: "D:\\Games\\Voxelight Launcher\\voxelight-launcher.exe",
      });
    });
    expect(container.querySelector("h1")?.textContent).toBe("Voxelight is ready");
    expect(harness.launchMock).not.toHaveBeenCalled();

    await click(buttonByText("Launch Voxelight"));
    expect(harness.launchMock).toHaveBeenCalledTimes(1);
    await click(buttonByText("Close"));
    expect(harness.closeMock).toHaveBeenCalledTimes(1);
  });

  it("shows Update and Reinstall modes with kept folder and refuses downgrades", async () => {
    const existingDir = "D:\\Apps\\Voxelight Launcher";
    const updateHarness = createHarness(
      defaultBootstrap({
        detected: {
          relation: { kind: "update", installedVersion: "0.7.0-beta.1", targetVersion: "0.7.0-beta.2" },
          installDir: existingDir,
          isExisting: true,
          pathLocked: true,
        },
        validation: {
          valid: true,
          normalizedPath: existingDir,
          errorCode: null,
          availableBytes: 50 * 1024 * 1024 * 1024,
          requiredBytes: 68 * 1024 * 1024,
        },
      }),
    );
    await mount(updateHarness);
    await click(buttonByText("Continue"));
    expect(container.textContent).toContain("Update from 0.7.0-beta.1 to 0.7.0-beta.2");
    expect(container.querySelector<HTMLInputElement>("input[type='text']")?.readOnly).toBe(true);
    expect(buttonByText("Browse").disabled).toBe(true);
    expect(buttonByText("Continue").disabled).toBe(false);
    expect(container.textContent).not.toContain("Open classic installer");

    // An in-place update keeps the shortcuts that already exist.
    await click(buttonByText("Continue"));
    const updateShortcuts = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']")[0];
    expect(updateShortcuts.disabled).toBe(true);
    expect(container.textContent).toContain("Existing shortcuts are kept as they are when updating.");

    // Re-mount as downgrade blocked.
    await act(async () => root.unmount());
    root = createRoot(container);
    const downgradeHarness = createHarness(
      defaultBootstrap({
        detected: {
          relation: { kind: "downgradeBlocked", installedVersion: "0.7.0", targetVersion: "0.7.0-beta.2" },
          installDir: existingDir,
          isExisting: true,
          pathLocked: true,
        },
      }),
    );
    await mount(downgradeHarness);
    await click(buttonByText("Continue"));
    expect(container.textContent).toContain("Newer version 0.7.0 is already installed");
    expect(buttonByText("Continue").disabled).toBe(true);
  });

  it("lets the user choose another folder when the registered one no longer holds the launcher", async () => {
    // Installed by the beta.2 NSIS page onto an external drive that is gone.
    const missingDir = "E:\\Voxelight Launcher";
    const harness = createHarness(
      defaultBootstrap({
        detected: {
          relation: { kind: "update", installedVersion: "0.7.0-beta.2", targetVersion: "0.7.0-beta.3" },
          installDir: missingDir,
          isExisting: true,
          pathLocked: false,
        },
        validation: {
          valid: false,
          normalizedPath: missingDir,
          errorCode: "path.driveMissing",
          availableBytes: null,
          requiredBytes: 68 * 1024 * 1024,
        },
      }),
    );
    harness.pickDirMock.mockResolvedValue("D:\\Games");
    await mount(harness);
    await click(buttonByText("Continue"));

    const input = container.querySelector<HTMLInputElement>("input[type='text']")!;
    expect(input.value).toBe(missingDir);
    expect(input.readOnly).toBe(false);
    expect(buttonByText("Browse").disabled).toBe(false);
    expect(buttonByText("Continue").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("does not exist");
    expect(container.textContent).toContain("no longer in its registered folder");
    expect(container.textContent).not.toContain("will be kept");
    expect(container.textContent).not.toContain("Open classic installer");

    await click(buttonByText("Browse"));
    expect(input.value).toBe("D:\\Games\\Voxelight Launcher");
    expect(buttonByText("Continue").disabled).toBe(false);
    await click(buttonByText("Continue"));
    expect(container.textContent).toContain("D:\\Games\\Voxelight Launcher");

    // The new folder gets new shortcuts, so the user chooses as for a fresh install.
    const shortcuts = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']")[0];
    expect(shortcuts.disabled).toBe(false);
    expect(shortcuts.checked).toBe(true);
    expect(container.textContent).toContain("Create shortcuts on your desktop and in the Start menu.");
    expect(container.textContent).not.toContain("Existing shortcuts are kept");
    await click(shortcuts);
    expect(shortcuts.checked).toBe(false);
    await click(shortcuts);
    expect(shortcuts.checked).toBe(true);

    await click(buttonByText("Update"));
    expect(harness.startInstallMock).toHaveBeenCalledWith({
      installDir: "D:\\Games\\Voxelight Launcher",
      createShortcuts: true,
    });
  });

  it("offers the classic installer when a kept installation folder can no longer be used", async () => {
    const keptDir = "C:\\ProgramData\\Voxelight Launcher";
    const bootstrap = defaultBootstrap({
      detected: {
        relation: { kind: "update", installedVersion: "0.7.0-beta.2", targetVersion: "0.7.0-beta.3" },
        installDir: keptDir,
        isExisting: true,
        pathLocked: true,
      },
      validation: {
        valid: false,
        normalizedPath: keptDir,
        errorCode: "path.sharedLocation",
        availableBytes: null,
        requiredBytes: 68 * 1024 * 1024,
      },
    });
    const harness = createHarness(bootstrap);
    let finishOpening!: () => void;
    harness.classicMock.mockImplementation(
      () => new Promise<void>((resolve) => {
        finishOpening = resolve;
      }),
    );
    await mount(harness);
    await click(buttonByText("Continue"));

    // The live installation stays in its folder: Setup never moves it silently.
    const input = container.querySelector<HTMLInputElement>("input[type='text']")!;
    expect(input.readOnly).toBe(true);
    expect(buttonByText("Browse").disabled).toBe(true);
    expect(buttonByText("Continue").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("ProgramData");
    expect(container.textContent).toContain("The classic installer can remove the old copy");

    const classic = buttonByText("Open classic installer");
    expect(classic.disabled).toBe(false);
    await click(classic);
    expect(harness.classicMock).toHaveBeenCalledTimes(1);
    expect(buttonByText("Open classic installer").disabled).toBe(true);
    await act(async () => finishOpening());
    expect(harness.startInstallMock).not.toHaveBeenCalled();

    // If the classic installer cannot be opened, say so and allow another try.
    await act(async () => root.unmount());
    root = createRoot(container);
    const failing = createHarness(bootstrap);
    failing.classicMock.mockRejectedValue(new Error("open_classic_installer not allowed"));
    await mount(failing);
    await click(buttonByText("Continue"));
    await click(buttonByText("Open classic installer"));
    const alerts = [...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
    expect(alerts).toContain("The classic installer could not be opened. Close Setup and run it again.");
    expect(buttonByText("Open classic installer").disabled).toBe(false);
  });

  it("appends the launcher folder when Browse selects a parent folder", async () => {
    const harness = createHarness();
    harness.pickDirMock.mockResolvedValue("D:\\Games");
    await mount(harness);
    await click(buttonByText("Continue"));
    await click(buttonByText("Browse"));
    const input = container.querySelector<HTMLInputElement>("input[type='text']")!;
    expect(input.value).toBe("D:\\Games\\Voxelight Launcher");
    expect(harness.validateMock).toHaveBeenLastCalledWith("D:\\Games\\Voxelight Launcher");

    // A folder already named Voxelight Launcher is kept as selected.
    harness.pickDirMock.mockResolvedValue("D:\\Games\\Voxelight Launcher");
    await click(buttonByText("Browse"));
    expect(input.value).toBe("D:\\Games\\Voxelight Launcher");

    // The install request, and therefore the byte monitor, uses the appended
    // install folder rather than the picked parent.
    await click(buttonByText("Continue"));
    await click(buttonByText("Install"));
    expect(harness.startInstallMock).toHaveBeenCalledWith({
      installDir: "D:\\Games\\Voxelight Launcher",
      createShortcuts: true,
    });
  });

  it("does not offer Launch when Setup is elevated and explains why", async () => {
    const harness = createHarness(defaultBootstrap({ launchAvailable: false }));
    await mount(harness);
    await click(buttonByText("Continue"));
    await click(buttonByText("Continue"));

    const checkboxes = container.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    expect(checkboxes[1].disabled).toBe(true);
    expect(container.textContent).toContain("open Voxelight from the Start menu");

    await click(buttonByText("Install"));
    expect(container.querySelector("h1")?.textContent).toBe("Voxelight is ready");
    expect(container.textContent).toContain("Setup is running as administrator");
    const labels = [...container.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels.some((text) => text.includes("Launch Voxelight"))).toBe(false);
    expect(harness.launchMock).not.toHaveBeenCalled();
  });

  it("asks the user to close a running launcher and retries", async () => {
    const failure: InstallFailure = {
      code: "launcherRunning",
      phase: "preflight",
      exitCode: null,
      detail: "Voxelight Launcher is running from D:\\Games\\Voxelight Launcher.",
    };
    const harness = createHarness();
    harness.startInstallMock
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        installDir: "C:\\Users\\User\\AppData\\Local\\Voxelight Launcher",
        executablePath: "C:\\Users\\User\\AppData\\Local\\Voxelight Launcher\\voxelight-launcher.exe",
      });
    await mount(harness);
    await click(buttonByText("Continue"));
    await click(buttonByText("Continue"));
    await click(buttonByText("Install"));

    expect(container.querySelector("h1")?.textContent).toBe("Installation did not finish");
    expect(container.textContent).toContain("Voxelight Launcher is still running. Close Voxelight, then choose Retry.");

    await click(buttonByText("Retry"));
    expect(container.querySelector("h1")?.textContent).toBe("Voxelight is ready");
    expect(harness.startInstallMock).toHaveBeenCalledTimes(2);
  });

  it("blocks Continue when path validation fails", async () => {
    const harness = createHarness();
    harness.validateMock.mockResolvedValue({
      valid: false,
      normalizedPath: "C:\\Program Files\\Voxelight",
      errorCode: "path.protectedLocation",
      availableBytes: null,
      requiredBytes: 68 * 1024 * 1024,
    });
    await mount(harness);
    await click(buttonByText("Continue"));
    const input = container.querySelector<HTMLInputElement>("input[type='text']")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "C:\\Program Files\\Voxelight");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Program Files");
    expect(buttonByText("Continue").disabled).toBe(true);
  });

  it("moves step focus to the heading without asking for a visible focus ring", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      const harness = createHarness();
      await act(async () => {
        root.render(
          <StrictMode>
            <SetupApp bridge={harness.bridge} />
          </StrictMode>,
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
      await click(buttonByText("Continue"));
      const heading = container.querySelector("h1")!;
      expect(document.activeElement).toBe(heading);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
    } finally {
      focus.mockRestore();
    }
  });

  it("shows extract, install and verify phases in browser preview mode", async () => {
    await act(async () => {
      root.render(<SetupApp />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await click(buttonByText("Continue"));
    await click(buttonByText("Continue"));

    vi.useFakeTimers();
    try {
      await click(buttonByText("Install"));
      expect(container.querySelector("h1")?.textContent).toBe("Installing Voxelight");
      const phaseStates = () =>
        [...container.querySelectorAll(".vx-setup-phase")].map((phase) =>
          phase.getAttribute("data-state"),
        );
      expect(phaseStates()).toEqual(["active", "pending", "pending"]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(phaseStates()).toEqual(["done", "active", "pending"]);
      expect(container.textContent).toContain("written");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5200);
      });
      expect(container.querySelector("h1")?.textContent).toBe("Voxelight is ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains NSIS exit codes, copies details, and retries successfully", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const failure: InstallFailure = {
      code: "nsisExit2",
      phase: "install",
      exitCode: 2,
      detail: "NSIS installer exited with code 2.",
    };
    const harness = createHarness();
    harness.startInstallMock
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        installDir: "C:\\Users\\User\\AppData\\Local\\Voxelight Launcher",
        executablePath: "C:\\Users\\User\\AppData\\Local\\Voxelight Launcher\\voxelight-launcher.exe",
      });

    await mount(harness);
    await click(buttonByText("Continue"));
    await click(buttonByText("Continue"));
    await click(buttonByText("Install"));

    expect(container.querySelector("h1")?.textContent).toBe("Installation did not finish");
    expect(container.textContent).toContain("exit code 2");

    await click(buttonByText("Copy details"));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("Exit code: 2");
    expect(container.textContent).toContain("Details copied to clipboard.");

    // Retry succeeds and triggers auto-launch (enabled by default).
    await click(buttonByText("Retry"));
    expect(container.querySelector("h1")?.textContent).toBe("Voxelight is ready");
    expect(harness.launchMock).toHaveBeenCalledTimes(1);
  });

  it("follows system light theme, reduced motion, and all seven languages with English fallback", async () => {
    expect(SETUP_LOCALES).toHaveLength(7);
    expect(resolveSetupLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(resolveSetupLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(resolveSetupLocale("ja-JP")).toBe("ja-JP");
    expect(resolveSetupLocale("ko-KR")).toBe("ko-KR");
    expect(resolveSetupLocale("ru-RU")).toBe("ru-RU");
    expect(resolveSetupLocale("es-MX")).toBe("es-ES");
    expect(resolveSetupLocale("de-DE")).toBe("en-US");

    const harness = createHarness(
      defaultBootstrap({
        appearance: {
          theme: "light",
          accentColor: "#ee9ec5",
          animationsEnabled: false,
          advancedEffectsEnabled: false,
          locale: "zh-CN",
        },
      }),
    );
    await mount(harness);
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.reducedMotion).toBe("true");
    expect(document.documentElement.dataset.reducedTransparency).toBe("true");
    expect(container.querySelector("h1")?.textContent).toBe("安装 Voxelight Launcher");
    expect(container.textContent).not.toContain("·");
  });
});
