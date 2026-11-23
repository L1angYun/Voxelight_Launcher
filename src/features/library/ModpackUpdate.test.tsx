// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createLauncherI18n } from "../../i18n";
import { formatDate } from "../../i18n/format";
import { command, type Instance } from "../../lib/launcher";
import type { ModpackUpdateCheck, ModpackVersion, PackUpdatePlan } from "./types";
import { ModpackUpdate } from "./ModpackUpdate";

const commandMock = vi.mocked(command);
let root: Root;
let container: HTMLDivElement;

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  desktop: true,
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

const newer: ModpackVersion[] = [
  { id: "pack-2", name: "Pack 2", versionNumber: "2.0.0", gameVersions: ["1.21.1"], loaders: ["fabric"], datePublished: "2026-02-01T00:00:00Z" },
  { id: "pack-1.5", name: "Pack 1.5", versionNumber: "1.5.0", gameVersions: ["1.21.1"], loaders: ["fabric"], datePublished: "2026-01-15T00:00:00Z" },
];

const plan: PackUpdatePlan = {
  from: { versionId: "pack-1.0", versionNumber: "1.0.0" },
  to: { versionId: "pack-2", versionNumber: "2.0.0" },
  add: 3,
  replace: 2,
  remove: 1,
  unchanged: 7,
  conflicts: [
    { path: "config/a.toml", reason: "userModified" },
    { path: "mods/b.jar", reason: "userAdded" },
  ],
  droppedIntents: ["mods/old-disabled.jar"],
  kept: [],
  optionalRemoved: [],
  skipped: ["saves/world", "logs/latest.log"],
  dependencyChange: {
    from: { minecraft: "1.21.1", fabric: "0.16.9" },
    to: { minecraft: "1.21.1", fabric: "0.17.0" },
  },
  downloadBytes: 2048,
  includeOptional: false,
  fingerprint: "fingerprint-1",
};

function makeCheck(overrides: Partial<ModpackUpdateCheck> = {}): ModpackUpdateCheck {
  return {
    managed: true,
    current: { versionId: "pack-1.0", versionNumber: "1.0.0" },
    newer,
    currentMissing: false,
    includeOptional: false,
    ...overrides,
  };
}

function makeCallbacks() {
  return {
    onChanged: vi.fn(async () => {}),
    onBackupsChanged: vi.fn(async () => {}),
    onRecoveryFault: vi.fn(),
  };
}

function updateElement(callbacks = makeCallbacks()) {
  return createElement(ModpackUpdate, { instance, ...callbacks });
}

function giveSelectBounds(select: HTMLElement) {
  vi.spyOn(select, "getBoundingClientRect").mockReturnValue({
    x: 100, y: 100, width: 240, height: 40, top: 100, bottom: 140, left: 100, right: 340,
    toJSON: () => ({}),
  });
}

const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);

function optionalCheckbox(): HTMLInputElement {
  return [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.includes("Include optional files"))!
    .querySelector("input")!;
}

function planCalls() {
  return commandMock.mock.calls.filter(([name]) => name === "plan_modpack_update");
}

async function render(node: ReactNode, language = "en-US") {
  const i18n = createLauncherI18n(language, language);
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, node)));
}

async function openPlan(callbacks = makeCallbacks()) {
  await render(updateElement(callbacks));
  await act(async () => button("Check for modpack update")!.click());
  await act(async () => button("Show update plan")!.click());
  return callbacks;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  commandMock.mockReset();
  commandMock.mockImplementation(async (name) => {
    if (name === "check_modpack_update") return makeCheck();
    if (name === "plan_modpack_update") return plan;
    if (name === "apply_modpack_update") return { instance, previousBackup: null };
    return null;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("modpack update", () => {
  it("does not request a check before the button is pressed", async () => {
    await render(updateElement());
    expect(commandMock).not.toHaveBeenCalled();
    expect(button("Check for modpack update")).toBeDefined();
    await act(async () => button("Check for modpack update")!.click());
    expect(commandMock).toHaveBeenCalledWith("check_modpack_update", { instanceId: instance.id });
  });

  it.each<[NonNullable<ModpackUpdateCheck["reason"]>, string]>([
    ["noLock", "no online modpack lock file"],
    ["legacyLock", "older modpack lock format"],
    ["noSource", "does not record an online source"],
    ["invalidLock", "cannot be read"],
  ])("shows the %s unmanaged note and no version select", async (reason, expected) => {
    commandMock.mockImplementation(async (name) => name === "check_modpack_update"
      ? makeCheck({ managed: false, reason, current: undefined, newer: [] })
      : null);
    await render(updateElement());
    await act(async () => button("Check for modpack update")!.click());
    expect(container.textContent).toContain(expected);
    expect(container.querySelectorAll(".vx-inline-notice")).toHaveLength(1);
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(button("Show update plan")).toBeUndefined();
    if (reason !== "invalidLock") expect(container.textContent).toContain("Reinstall the pack from Discover");
  });

  it("shows the current version when up to date and notes a version missing from its platform", async () => {
    let currentMissing = false;
    commandMock.mockImplementation(async (name) => name === "check_modpack_update"
      ? makeCheck({ newer: [], currentMissing })
      : null);
    await render(updateElement());
    await act(async () => button("Check for modpack update")!.click());
    expect(container.textContent).toContain("This modpack is up to date (version 1.0.0).");
    expect(container.textContent).not.toContain("no longer listed on its platform");
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    currentMissing = true;
    await act(async () => button("Check for modpack update")!.click());
    expect(container.textContent).toContain("The installed version is no longer listed on its platform.");
  });

  it("shows the choose-carefully notice when the installed version is missing but versions are listed", async () => {
    commandMock.mockImplementation(async (name) => name === "check_modpack_update"
      ? makeCheck({ currentMissing: true })
      : null);
    await render(updateElement());
    await act(async () => button("Check for modpack update")!.click());
    expect(container.textContent).toContain(
      "The installed version is no longer listed on its platform, so every version of this pack is shown. " +
      "Choose carefully: an older version is not refused.",
    );
    expect(container.querySelector('[role="combobox"]')).not.toBeNull();
  });

  it.each([true, false])("shows the optional checkbox from the check result and always sends a boolean (%s)", async (includeOptional) => {
    commandMock.mockImplementation(async (name, args) => {
      if (name === "check_modpack_update") return makeCheck({ includeOptional });
      if (name === "plan_modpack_update") return { ...plan, includeOptional: args?.includeOptional as boolean };
      return null;
    });
    await render(updateElement());
    await act(async () => button("Check for modpack update")!.click());
    expect(optionalCheckbox().checked).toBe(includeOptional);
    await act(async () => button("Show update plan")!.click());
    expect(planCalls().at(-1)?.[1]).toEqual({
      instanceId: instance.id,
      newVersionId: "pack-2",
      includeOptional,
    });
  });

  it("updates the optional checkbox to agree with the plan result", async () => {
    commandMock.mockImplementation(async (name) => {
      if (name === "check_modpack_update") return makeCheck({ includeOptional: false });
      if (name === "plan_modpack_update") return { ...plan, includeOptional: true };
      return null;
    });
    await render(updateElement());
    await act(async () => button("Check for modpack update")!.click());
    expect(optionalCheckbox().checked).toBe(false);
    await act(async () => button("Show update plan")!.click());
    expect(optionalCheckbox().checked).toBe(true);
  });

  it("lists newer versions and sends the selected version and optional choice when planning", async () => {
    await render(updateElement());
    await act(async () => button("Check for modpack update")!.click());
    const select = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    expect(select).not.toBeNull();
    giveSelectBounds(select);
    await act(async () => select.click());
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((option) => option.dataset.value)).toEqual(["pack-2", "pack-1.5"]);
    expect(options[0].textContent).toContain("2.0.0");
    expect(options[0].textContent).toContain(formatDate(newer[0].datePublished, "en-US"));
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="pack-1.5"]')!.click());
    await act(async () => button("Show update plan")!.click());
    expect(commandMock).toHaveBeenCalledWith("plan_modpack_update", {
      instanceId: instance.id,
      newVersionId: "pack-1.5",
      includeOptional: false,
    });
    const optional = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Include optional files"))!
      .querySelector("input")!;
    await act(async () => optional.click());
    await act(async () => button("Show update plan")!.click());
    expect(planCalls().at(-1)?.[1]).toEqual({
      instanceId: instance.id,
      newVersionId: "pack-1.5",
      includeOptional: true,
    });
  });

  it("shows plan counts, dependency changes, dropped intents, skipped paths, and unchecked conflicts", async () => {
    await openPlan();
    expect(container.textContent).toContain("1.0.0 → 2.0.0");
    expect(container.textContent).toContain("Added: 3 · Replaced: 2 · Removed: 1 · Unchanged: 7");
    expect(container.textContent).toContain("Download size: 2 KiB");
    expect(container.textContent).toContain("Dependency changes");
    expect(container.textContent).toContain("fabric: 0.16.9 → 0.17.0");
    expect(container.textContent).not.toContain("minecraft: 1.21.1 → 1.21.1");
    expect(container.textContent).toContain("mods/old-disabled.jar");
    expect(container.textContent).toContain("2 paths are left alone on purpose");
    expect(container.textContent).toContain("config/a.toml");
    expect(container.textContent).toContain("You modified this file.");
    expect(container.textContent).toContain("mods/b.jar");
    expect(container.textContent).toContain("You added this file.");
    const conflicts = [...container.querySelectorAll<HTMLInputElement>("[data-conflict-path]")];
    expect(conflicts.map((input) => input.dataset.conflictPath)).toEqual(["config/a.toml", "mods/b.jar"]);
    expect(conflicts.every((input) => input.checked === false)).toBe(true);
  });

  it("shows the files the new version keeps as the user has them", async () => {
    commandMock.mockImplementation(async (name) => {
      if (name === "check_modpack_update") return makeCheck();
      if (name === "plan_modpack_update") return { ...plan, kept: ["config/kept.toml", "options.txt"] };
      return null;
    });
    await openPlan();
    expect(container.textContent).toContain(
      "The new version does not change these files, so your changes to them are kept:",
    );
    const kept = [...container.querySelectorAll("li.vx-path")].map((node) => node.textContent);
    expect(kept).toContain("config/kept.toml");
    expect(kept).toContain("options.txt");
  });

  it("shows the optional files the plan removes and explains how to keep them", async () => {
    commandMock.mockImplementation(async (name) => {
      if (name === "check_modpack_update") return makeCheck();
      if (name === "plan_modpack_update") return {
        ...plan,
        optionalRemoved: ["mods/optional-a.jar", "mods/optional-b.jar"],
      };
      return null;
    });
    await openPlan();
    expect(container.textContent).toContain(
      "These files are optional in the new version and will be removed because optional files are not included. " +
      "Tick \"Include optional files\" and show the plan again to keep them:",
    );
    const paths = [...container.querySelectorAll("li.vx-path")].map((node) => node.textContent);
    expect(paths).toContain("mods/optional-a.jar");
    expect(paths).toContain("mods/optional-b.jar");
  });

  it("lists files CurseForge does not let the launcher download and blocks Apply", async () => {
    const projectUrl = "https://www.curseforge.com/minecraft/mc-mods/restricted-fixture";
    commandMock.mockImplementation(async (name) => {
      if (name === "check_modpack_update") return makeCheck();
      if (name === "plan_modpack_update") return {
        ...plan,
        // A disabled mod: the file goes where the update writes it.
        manual: [{ path: "mods/restricted-fixture.jar", target: "mods/restricted-fixture.jar.disabled", projectUrl, conflict: false }],
      };
      return null;
    });
    await openPlan();
    expect(container.textContent).toContain(
      "CurseForge does not let the launcher download these files. " +
      "Download each one from its page and put it at the path shown, then show the plan again:",
    );
    const row = [...container.querySelectorAll("li.vx-path")]
      .find((node) => node.textContent?.includes("mods/restricted-fixture.jar"))!;
    expect(row).toBeDefined();
    expect(row.querySelector("span")!.textContent).toBe("mods/restricted-fixture.jar.disabled");
    const link = row.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(projectUrl);
    expect(link.textContent).toContain("Download manually");
    expect(container.textContent).not.toContain("needed only if you use the new version for this file");
    expect(button("Apply update")!.disabled).toBe(true);
  });

  it("allows Apply for a manual conflict until the new version is chosen for it", async () => {
    const path = "mods/restricted-choice.jar";
    commandMock.mockImplementation(async (name) => {
      if (name === "check_modpack_update") return makeCheck();
      if (name === "plan_modpack_update") return {
        ...plan,
        conflicts: [{ path, reason: "userModified" }],
        // The choice is keyed by the plan path, not by where the file goes.
        manual: [{ path, target: `${path}.disabled`, projectUrl: "https://www.curseforge.com/minecraft/mc-mods/restricted-choice", conflict: true }],
      };
      return null;
    });
    await openPlan();
    expect(container.textContent).toContain("needed only if you use the new version for this file");
    expect(button("Apply update")!.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLInputElement>(`[data-conflict-path="${path}"]`)!.click());
    expect(button("Apply update")!.disabled).toBe(true);
  });

  it("shows the files a refused plan names as they are written", async () => {
    const files = "「Restricted & Co」 → mods/restricted.jar（https://www.curseforge.com/minecraft/mc-mods/restricted）";
    commandMock.mockImplementation(async (name) => {
      if (name === "check_modpack_update") return makeCheck();
      if (name === "plan_modpack_update") throw { code: "modpack.manualDownload", params: { files } };
      return null;
    });
    await openPlan();
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe(
      "These files' authors do not allow other apps to download them, so the launcher stopped and changed nothing. " +
      `Download them from their pages: ${files}`,
    );
  });

  it("keeps the params of a failed check and a failed apply", async () => {
    const files = "「Restricted」 → mods/restricted.jar（https://www.curseforge.com/minecraft/mc-mods/restricted）";
    const failure = { code: "modpack.manualDownload", params: { files } };
    commandMock.mockImplementation(async (name) => {
      if (name === "check_modpack_update") throw failure;
      return null;
    });
    await render(updateElement(makeCallbacks()));
    await act(async () => button("Check for modpack update")!.click());
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(files);

    commandMock.mockImplementation(async (name) => {
      if (name === "check_modpack_update") return makeCheck();
      if (name === "plan_modpack_update") return plan;
      if (name === "apply_modpack_update") throw failure;
      return null;
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => button("Check for modpack update")!.click());
    await act(async () => button("Show update plan")!.click());
    await act(async () => button("Apply update")!.click());
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(files);
  });

  it("applies with the plan fingerprint and per-conflict choices, then reports success and refreshes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onChanged, onBackupsChanged } = await openPlan();
    await act(async () => container.querySelector<HTMLInputElement>('[data-conflict-path="mods/b.jar"]')!.click());
    await act(async () => button("Apply update")!.click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(commandMock).toHaveBeenCalledWith("apply_modpack_update", {
      instanceId: instance.id,
      newVersionId: "pack-2",
      includeOptional: false,
      fingerprint: "fingerprint-1",
      choices: [
        { path: "config/a.toml", useUpstream: false },
        { path: "mods/b.jar", useUpstream: true },
      ],
    });
    const notice = [...container.querySelectorAll(".vx-inline-notice")]
      .find((node) => node.textContent?.includes("Updated to version 2.0.0"));
    expect(notice?.textContent).toContain("the previous state was backed up");
    expect(container.querySelector("[data-update-plan]")).toBeNull();
    expect(button("Apply update")).toBeUndefined();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onBackupsChanged).toHaveBeenCalledTimes(1);
  });

  it("re-checks after a successful apply and keeps the applied notice", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let checks = 0;
    commandMock.mockImplementation(async (name) => {
      if (name === "check_modpack_update") {
        checks += 1;
        return checks === 1
          ? makeCheck()
          : makeCheck({ current: { versionId: "pack-2", versionNumber: "2.0.0" }, newer: [] });
      }
      if (name === "plan_modpack_update") return plan;
      if (name === "apply_modpack_update") return { instance, previousBackup: null };
      return null;
    });
    const { onChanged, onBackupsChanged } = await openPlan();
    await act(async () => button("Apply update")!.click());
    const checkCalls = commandMock.mock.calls.filter(([name]) => name === "check_modpack_update");
    expect(checkCalls).toHaveLength(2);
    expect(checkCalls[1][1]).toEqual({ instanceId: instance.id });
    expect(container.textContent).toContain("Updated to version 2.0.0");
    expect(container.textContent).toContain("This modpack is up to date (version 2.0.0).");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onBackupsChanged).toHaveBeenCalledTimes(1);
  });

  it.each(["backup.restoreRecoveryRequired", "backup.restoreRolledBack"])(
    "reports a %s failure to the backups section and refreshes it",
    async (code) => {
      const failure = {
        code,
        params: {
          currentDirectory: "D:/game/instances/modpack",
          previousDirectory: "D:/game/instances/.before-restore-x",
        },
      };
      commandMock.mockImplementation(async (name) => {
        if (name === "check_modpack_update") return makeCheck();
        if (name === "plan_modpack_update") return plan;
        if (name === "apply_modpack_update") throw failure;
        return null;
      });
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const { onChanged, onBackupsChanged, onRecoveryFault } = await openPlan();
      await act(async () => button("Apply update")!.click());
      expect(onRecoveryFault).toHaveBeenCalledWith(failure);
      expect(onBackupsChanged).toHaveBeenCalledTimes(1);
      expect(onChanged).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    },
  );

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
  ])("uses modpack update wording for a %s failure and shell wording without a kind", async (code, packText, backupText) => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let kind: "packUpdate" | undefined = "packUpdate";
    commandMock.mockImplementation(async (name) => {
      if (name === "check_modpack_update") return makeCheck();
      if (name === "plan_modpack_update") return plan;
      if (name === "apply_modpack_update") throw {
        code,
        params: {
          currentDirectory: "D:/game/instances/modpack",
          previousDirectory: "D:/game/instances/.before-restore-x",
          ...(kind ? { kind } : {}),
        },
      };
      return null;
    });
    await openPlan();
    await act(async () => button("Apply update")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(packText);
    kind = undefined;
    await act(async () => button("Apply update")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(backupText);
  });

  it("names the old folder when the update kept it", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    commandMock.mockImplementation(async (name) => {
      if (name === "check_modpack_update") return makeCheck();
      if (name === "plan_modpack_update") return plan;
      if (name === "apply_modpack_update") return { instance, previousBackup: null, previousDirectory: "D:/game/instances/.before-restore-x" };
      return null;
    });
    await openPlan();
    await act(async () => button("Apply update")!.click());
    expect(container.textContent).toContain("the old folder was kept: D:/game/instances/.before-restore-x");
  });

  it("replans automatically after modpack.planChanged without applying twice or touching backups", async () => {
    let plans = 0;
    const regeneratedPlan: PackUpdatePlan = { ...plan, add: 5, fingerprint: "fingerprint-2" };
    commandMock.mockImplementation(async (name) => {
      if (name === "check_modpack_update") return makeCheck();
      if (name === "plan_modpack_update") {
        plans += 1;
        return plans === 1 ? plan : regeneratedPlan;
      }
      if (name === "apply_modpack_update") throw { code: "modpack.planChanged", params: {} };
      return null;
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onBackupsChanged, onRecoveryFault } = await openPlan();
    await act(async () => button("Apply update")!.click());
    const applyCalls = commandMock.mock.calls.filter(([name]) => name === "apply_modpack_update");
    expect(applyCalls).toHaveLength(1);
    expect(plans).toBe(2);
    expect(planCalls()[1][1]).toEqual({
      instanceId: instance.id,
      newVersionId: "pack-2",
      includeOptional: false,
    });
    expect(commandMock.mock.calls.filter(([name]) => name === "check_modpack_update")).toHaveLength(1);
    expect(onBackupsChanged).not.toHaveBeenCalled();
    expect(onRecoveryFault).not.toHaveBeenCalled();
    expect(container.textContent).toContain("A new plan was made; review it before applying.");
    expect(container.textContent).toContain("Added: 5");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("Apply update")).toBeDefined();
  });

  it("sends nothing when the apply confirmation is declined", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await openPlan();
    const before = commandMock.mock.calls.length;
    await act(async () => button("Apply update")!.click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(commandMock.mock.calls).toHaveLength(before);
    expect(commandMock.mock.calls.filter(([name]) => name === "apply_modpack_update")).toHaveLength(0);
    expect(container.querySelector("[data-update-plan]")).not.toBeNull();
  });
});
