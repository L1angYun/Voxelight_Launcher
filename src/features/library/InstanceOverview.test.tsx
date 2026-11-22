// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createLauncherI18n } from "../../i18n";
import { command, type Instance } from "../../lib/launcher";
import { InstanceOverview } from "./InstanceOverview";

const commandMock = vi.mocked(command);
let root: Root;
let container: HTMLDivElement;

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  desktop: true,
}));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => ({ run: (_key: string, action: () => Promise<unknown>) => action() }),
}));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false }),
}));
vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children, className }: { children: ReactNode; className?: string }) => createElement("div", { className }, children),
}));

const instance: Instance = {
  id: "fixture-modpack",
  name: "Modpack fixture",
  versionId: "1.21.1",
  gameDirectory: "C:\\SyntheticFixture\\modpack",
  createdAt: "2026-10-25T08:00:00Z",
  category: "",
  notes: "",
  totalPlayTime: 0,
  loader: "fabric",
  loaderVersion: "0.16.9",
};

const packUpdateInterrupted = "A modpack update was interrupted. Recover it before restoring a backup or updating again.";
const backupInterrupted = "The previous backup restore was interrupted. Recover it before selecting a different backup.";

function recovery(kind?: "backup" | "packUpdate") {
  return {
    currentDirectory: instance.gameDirectory,
    previousDirectory: "C:\\SyntheticFixture\\before-restore",
    ...(kind ? { kind } : {}),
  };
}

const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);

async function render() {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(InstanceOverview, { instance, onChanged: vi.fn(async () => {}) }))));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  commandMock.mockReset();
  commandMock.mockImplementation(async (name) => name === "list_instance_backups"
    ? { backups: [], warnings: [], recovery: null }
    : null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("instance overview backups", () => {
  it("shows interrupted modpack update wording for a pack-update recovery", async () => {
    commandMock.mockImplementation(async (name) => name === "list_instance_backups"
      ? { backups: [], warnings: [], recovery: recovery("packUpdate") }
      : null);
    await render();
    expect(container.textContent).toContain(packUpdateInterrupted);
    expect(button("Recover interrupted modpack update")).toBeDefined();
    expect(button("Recover interrupted backup restore")).toBeUndefined();
  });

  it.each([
    ["no kind", undefined],
    ["the backup kind", "backup"],
  ] as const)("keeps the backup wording with %s", async (_label, kind) => {
    commandMock.mockImplementation(async (name) => name === "list_instance_backups"
      ? { backups: [], warnings: [], recovery: recovery(kind) }
      : null);
    await render();
    expect(container.textContent).toContain(backupInterrupted);
    expect(button("Recover interrupted backup restore")).toBeDefined();
    expect(button("Recover interrupted modpack update")).toBeUndefined();
  });

  it("confirms and completes a pack-update recovery with the instance name", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let recovered = false;
    commandMock.mockImplementation(async (name) => {
      if (name === "list_instance_backups") return {
        backups: [], warnings: [], recovery: recovered ? null : recovery("packUpdate"),
      };
      if (name === "recover_instance_restore") {
        recovered = true;
        return { instance, preservedDirectory: "C:\\SyntheticFixture\\verified-new-copy", previousBackup: null };
      }
      return null;
    });
    await render();
    await act(async () => button("Recover interrupted modpack update")!.click());
    expect(confirm).toHaveBeenCalledWith(
      `Undo the interrupted modpack update of "${instance.name}" and reinstate its original directory once the copies are verified?`,
    );
    expect(commandMock).toHaveBeenCalledWith("recover_instance_restore", { instanceId: instance.id });
    expect(container.textContent).toContain(
      "The interrupted modpack update was undone; the instance is as it was before the update.",
    );
    expect(button("Recover interrupted modpack update")).toBeUndefined();
  });

  it.each([
    [
      "backup.restoreRecoveryRequired",
      "The modpack update did not finish. Keep the listed directories and use the recovery action in the backups section.",
      "The backup restore did not finish. Keep the listed directories and use the recovery action to verify the copies again.",
    ],
    [
      "backup.restoreRolledBack",
      "The modpack update could not finish. The original directory was restored.",
      "The backup restore could not finish. The original directory was restored.",
    ],
  ])("reports a %s recovery failure with the operation's wording", async (code, packText, backupText) => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let kind: "packUpdate" | undefined = "packUpdate";
    commandMock.mockImplementation(async (name) => {
      if (name === "list_instance_backups") return {
        backups: [], warnings: [], recovery: recovery("packUpdate"),
      };
      if (name === "recover_instance_restore") throw {
        code,
        params: {
          currentDirectory: instance.gameDirectory,
          previousDirectory: "C:\\SyntheticFixture\\before-restore",
          ...(kind ? { kind } : {}),
        },
      };
      return null;
    });
    await render();
    await act(async () => button("Recover interrupted modpack update")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(packText);
    kind = undefined;
    await act(async () => button("Recover interrupted modpack update")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(backupText);
  });
});
