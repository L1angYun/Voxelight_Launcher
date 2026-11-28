// SPDX-License-Identifier: GPL-3.0-only
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface SystemAppearance {
  theme: "light" | "dark";
  accentColor: string;
  animationsEnabled: boolean;
  advancedEffectsEnabled: boolean;
  locale: string;
}

export type InstallRelation =
  | { kind: "fresh" }
  | { kind: "update"; installedVersion: string; targetVersion: string }
  | { kind: "reinstall"; version: string }
  | { kind: "downgradeBlocked"; installedVersion: string; targetVersion: string };

export interface DetectedInstall {
  relation: InstallRelation;
  installDir: string;
  isExisting: boolean;
  /**
   * True while installDir still holds the installed launcher: Setup keeps that
   * folder. False for a fresh install and for a registered folder whose
   * launcher is gone, where the user may choose another folder.
   */
  pathLocked: boolean;
}

export interface PathValidation {
  valid: boolean;
  normalizedPath: string;
  errorCode: string | null;
  availableBytes: number | null;
  requiredBytes: number;
}

export interface SetupBootstrap {
  version: string;
  appearance: SystemAppearance;
  detected: DetectedInstall;
  validation: PathValidation;
  expectedInstallBytes: number;
  /** False when Setup is elevated and must not start the launcher itself. */
  launchAvailable: boolean;
}

export type InstallPhase = "extract" | "install" | "verify";

export interface InstallProgress {
  phase: InstallPhase;
  completed: number;
  total: number;
  indeterminate: boolean;
  bytesWritten: number;
  expectedBytes: number;
}

export interface InstallFailure {
  code: string;
  phase: InstallPhase | string;
  exitCode: number | null;
  detail: string;
}

export interface InstallOutcome {
  installDir: string;
  executablePath: string;
}

export interface InstallRequest {
  installDir: string;
  createShortcuts: boolean;
}

export interface SetupBridge {
  getSetupState(): Promise<SetupBootstrap>;
  getLicenseText(): Promise<string>;
  validateInstallPath(path: string): Promise<PathValidation>;
  pickInstallDirectory(currentDir?: string): Promise<string | null>;
  startInstall(request: InstallRequest): Promise<InstallOutcome>;
  /** Closes Setup and opens the embedded installer with its own pages. */
  openClassicInstaller(): Promise<void>;
  launchInstalled(): Promise<void>;
  minimizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  onInstallProgress(handler: (progress: InstallProgress) => void): Promise<UnlistenFn>;
  onAppearanceChange(handler: (appearance: SystemAppearance) => void): Promise<UnlistenFn>;
}

function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function previewBootstrap(): SetupBootstrap {
  const prefersLight =
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: light)").matches;
  const fallbackDir = "C:\\Users\\User\\AppData\\Local\\Voxelight Launcher";
  return {
    version: "0.7.0-beta.2",
    appearance: {
      theme: prefersLight ? "light" : "dark",
      accentColor: "#0078d4",
      animationsEnabled: true,
      advancedEffectsEnabled: true,
      locale: typeof navigator !== "undefined" ? navigator.language : "en-US",
    },
    detected: {
      relation: { kind: "fresh" },
      installDir: fallbackDir,
      isExisting: false,
      pathLocked: false,
    },
    validation: {
      valid: true,
      normalizedPath: fallbackDir,
      errorCode: null,
      availableBytes: 64 * 1024 * 1024 * 1024,
      requiredBytes: 68 * 1024 * 1024,
    },
    expectedInstallBytes: 36 * 1024 * 1024,
    launchAvailable: true,
  };
}

export const PREVIEW_INSTALL_STEP_MS = 100;
export const PREVIEW_INSTALL_DURATION_MS = 5200;
export const PREVIEW_EXPECTED_INSTALL_BYTES = 36 * 1024 * 1024;
const PREVIEW_EXTRACT_END_MS = 1200;
const PREVIEW_INSTALL_END_MS = 4000;

/**
 * Preview timings for the three phases the real NSIS run reports. Extract wins
 * the first 1.2 s, install the next 2.8 s, and verify the last 1.2 s so each
 * phase stays on screen long enough to inspect or screenshot.
 */
export function previewInstallProgress(
  elapsedMs: number,
  expectedBytes: number = PREVIEW_EXPECTED_INSTALL_BYTES,
): InstallProgress {
  const duration = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const elapsed = Math.min(duration, PREVIEW_INSTALL_DURATION_MS);
  const expected = expectedBytes > 0 ? expectedBytes : PREVIEW_EXPECTED_INSTALL_BYTES;
  if (elapsed < PREVIEW_EXTRACT_END_MS) {
    const fraction = elapsed / PREVIEW_EXTRACT_END_MS;
    return {
      phase: "extract",
      completed: Math.round(fraction * 150),
      total: 1000,
      indeterminate: false,
      bytesWritten: 0,
      expectedBytes: expected,
    };
  }
  if (elapsed < PREVIEW_INSTALL_END_MS) {
    const fraction = (elapsed - PREVIEW_EXTRACT_END_MS)
      / (PREVIEW_INSTALL_END_MS - PREVIEW_EXTRACT_END_MS);
    return {
      phase: "install",
      completed: 150 + Math.round(fraction * 770),
      total: 1000,
      indeterminate: false,
      bytesWritten: Math.round(expected * fraction),
      expectedBytes: expected,
    };
  }
  const fraction = (elapsed - PREVIEW_INSTALL_END_MS)
    / (PREVIEW_INSTALL_DURATION_MS - PREVIEW_INSTALL_END_MS);
  return {
    phase: "verify",
    completed: 920 + Math.round(fraction * 80),
    total: 1000,
    indeterminate: false,
    bytesWritten: expected,
    expectedBytes: expected,
  };
}

/**
 * Browser-only bridge used by `vite --mode setup`. It reports the same phases
 * as the Tauri bridge so the installing step can be seen and screenshotted;
 * the real bridge below is untouched and is used whenever Tauri is present.
 */
export function createPreviewSetupBridge(): SetupBridge {
  const bootstrap = previewBootstrap();
  const progressHandlers = new Set<(progress: InstallProgress) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let installing = false;

  return {
    async getSetupState() {
      return bootstrap;
    },
    async getLicenseText() {
      return "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007";
    },
    async validateInstallPath(path: string) {
      const trimmed = path.trim();
      const valid = /^[A-Za-z]:\\.+/.test(trimmed);
      return {
        valid,
        normalizedPath: trimmed,
        errorCode: valid ? null : "path.notAbsolute",
        availableBytes: 64 * 1024 * 1024 * 1024,
        requiredBytes: 68 * 1024 * 1024,
      };
    },
    async pickInstallDirectory() {
      return null;
    },
    startInstall(request: InstallRequest) {
      if (installing) {
        const failure: InstallFailure = {
          code: "alreadyInstalling",
          phase: "extract",
          exitCode: null,
          detail: "A preview installation is already running.",
        };
        return Promise.reject(failure);
      }
      installing = true;
      let elapsed = 0;
      return new Promise<InstallOutcome>((resolve) => {
        const tick = () => {
          elapsed += PREVIEW_INSTALL_STEP_MS;
          const progress = previewInstallProgress(elapsed, bootstrap.expectedInstallBytes);
          for (const handler of progressHandlers) handler(progress);
          if (progress.phase === "verify" && progress.completed >= progress.total) {
            if (timer !== null) clearInterval(timer);
            timer = null;
            installing = false;
            resolve({
              installDir: request.installDir,
              executablePath: `${request.installDir}\\voxelight-launcher.exe`,
            });
          }
        };
        timer = setInterval(tick, PREVIEW_INSTALL_STEP_MS);
      });
    },
    async openClassicInstaller() {},
    async launchInstalled() {},
    async minimizeWindow() {},
    async closeWindow() {},
    async onInstallProgress(handler) {
      progressHandlers.add(handler);
      return () => {
        progressHandlers.delete(handler);
      };
    },
    async onAppearanceChange() {
      return () => {};
    },
  };
}

export function createTauriSetupBridge(): SetupBridge {
  if (!hasTauriRuntime()) {
    return createPreviewSetupBridge();
  }

  return {
    getSetupState() {
      return invoke<SetupBootstrap>("get_setup_state");
    },
    getLicenseText() {
      return invoke<string>("get_license_text");
    },
    validateInstallPath(path: string) {
      return invoke<PathValidation>("validate_install_path", { path });
    },
    pickInstallDirectory(currentDir?: string) {
      return invoke<string | null>("pick_install_directory", { currentDir: currentDir ?? null });
    },
    startInstall(request: InstallRequest) {
      return invoke<InstallOutcome>("start_install", { request });
    },
    openClassicInstaller() {
      return invoke<void>("open_classic_installer");
    },
    launchInstalled() {
      return invoke<void>("launch_installed");
    },
    async minimizeWindow() {
      try {
        await getCurrentWindow().minimize();
      } catch {
        // Window may already be closing.
      }
    },
    async closeWindow() {
      try {
        await getCurrentWindow().close();
      } catch {
        // Window may already be closing.
      }
    },
    onInstallProgress(handler) {
      return listen<InstallProgress>("setup://install-progress", (event) => handler(event.payload));
    },
    onAppearanceChange(handler) {
      return listen<SystemAppearance>("setup://system-appearance", (event) => handler(event.payload));
    },
  };
}

export function normalizeInstallFailure(error: unknown): InstallFailure {
  if (error && typeof error === "object" && "code" in error && "detail" in error) {
    const candidate = error as Partial<InstallFailure>;
    return {
      code: typeof candidate.code === "string" ? candidate.code : "nsisExitOther",
      phase: typeof candidate.phase === "string" ? candidate.phase : "install",
      exitCode: typeof candidate.exitCode === "number" ? candidate.exitCode : null,
      detail: typeof candidate.detail === "string" ? candidate.detail : String(error),
    };
  }
  return {
    code: "spawnFailed",
    phase: "install",
    exitCode: null,
    detail: error instanceof Error ? error.message : String(error),
  };
}
