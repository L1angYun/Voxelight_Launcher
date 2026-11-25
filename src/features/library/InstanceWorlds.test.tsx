// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { command } from "../../lib/launcher";
import { pickLauncherPaths } from "../../lib/nativePaths";
import { InstanceWorlds } from "./InstanceWorlds";

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  desktop: true,
  command: vi.fn(),
}));

vi.mock("../../lib/nativePaths", () => ({
  pickLauncherPath: vi.fn(),
  pickLauncherPaths: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
    i18n: { language: "en-US" },
  }),
}));

const commandMock = vi.mocked(command);
const pickLauncherPathsMock = vi.mocked(pickLauncherPaths);

let root: Root;
let container: HTMLDivElement;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonByText(text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes(text),
  );
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  commandMock.mockReset();
  pickLauncherPathsMock.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("InstanceWorlds data packs", () => {
  it("lists, imports, toggles, and deletes data packs for a selected world", async () => {
    let packs = [
      {
        fileName: "Terralith.zip",
        name: "Terralith",
        isDirectory: false,
        enabled: true,
        sizeBytes: 2048,
        description: "Overworld terrain",
        packFormat: 48,
      },
      {
        fileName: "Tweaks.disabled",
        name: "Tweaks",
        isDirectory: true,
        enabled: false,
        sizeBytes: 512,
        description: null,
        packFormat: 88,
      },
    ];
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_worlds") {
        return [{ folderName: "Survival", name: "Survival World", hardcore: false, sizeBytes: 4096 }];
      }
      if (name === "list_screenshots") return [];
      if (name === "list_world_datapacks") return [...packs];
      if (name === "import_world_datapacks") {
        packs = [
          ...packs,
          {
            fileName: "NewPack.zip",
            name: "NewPack",
            isDirectory: false,
            enabled: true,
            sizeBytes: 1024,
            description: "Fresh pack",
            packFormat: 48,
          },
        ];
        return [packs[2]];
      }
      if (name === "toggle_world_datapack") {
        const fileName = (args as { fileName: string }).fileName;
        packs = packs.map((pack) =>
          pack.fileName === fileName
            ? { ...pack, enabled: !pack.enabled, fileName: pack.enabled ? `${fileName}.disabled` : fileName.replace(/\.disabled$/, "") }
            : pack,
        );
        return packs[0];
      }
      if (name === "delete_world_datapack") {
        const fileName = (args as { fileName: string }).fileName;
        packs = packs.filter((pack) => pack.fileName !== fileName);
        return null;
      }
      return null;
    });

    await act(async () => {
      root.render(createElement(InstanceWorlds, { versionId: "1.21.4", instanceId: "inst-1" }));
    });
    await flush();

    const openPacks = buttonByText("library:datapacks");
    expect(openPacks).toBeDefined();
    expect(openPacks?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      openPacks!.click();
    });
    await flush();

    expect(commandMock).toHaveBeenCalledWith("list_world_datapacks", {
      versionId: "1.21.4",
      instanceId: "inst-1",
      worldFolder: "Survival",
    });
    expect(container.textContent).toContain("Terralith");
    expect(container.textContent).toContain("Overworld terrain");
    expect(container.textContent).toContain("library:datapackFolder");

    // Import data packs via native picker
    pickLauncherPathsMock.mockResolvedValue(["C:\\packs\\NewPack.zip"]);
    await act(async () => {
      buttonByText("library:importDatapacks")!.click();
    });
    await flush();

    expect(pickLauncherPathsMock).toHaveBeenCalledWith("datapack");
    expect(commandMock).toHaveBeenCalledWith("import_world_datapacks", {
      versionId: "1.21.4",
      instanceId: "inst-1",
      worldFolder: "Survival",
      paths: ["C:\\packs\\NewPack.zip"],
    });
    expect(container.textContent).toContain("NewPack");
    expect(container.textContent).toContain("library:notice.datapacksImported");

    // Toggle first datapack
    const enabledBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (btn) => btn.getAttribute("aria-pressed") === "true",
    );
    expect(enabledBtn).toBeDefined();
    await act(async () => {
      enabledBtn!.click();
    });
    await flush();

    expect(commandMock).toHaveBeenCalledWith("toggle_world_datapack", {
      versionId: "1.21.4",
      instanceId: "inst-1",
      worldFolder: "Survival",
      fileName: "Terralith.zip",
    });
    expect(container.textContent).toContain("library:notice.datapackToggled");

    // Cancel confirmation must not delete
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const deleteButtons = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].filter((btn) =>
        btn.textContent?.includes("library:deleteDatapack"),
      );
    await act(async () => {
      deleteButtons()[0].click();
    });
    await flush();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(commandMock).not.toHaveBeenCalledWith("delete_world_datapack", expect.anything());

    // Confirming deletes the datapack
    await act(async () => {
      deleteButtons()[0].click();
    });
    await flush();
    expect(commandMock).toHaveBeenCalledWith("delete_world_datapack", {
      versionId: "1.21.4",
      instanceId: "inst-1",
      worldFolder: "Survival",
      fileName: "Terralith.zip.disabled",
    });
    expect(container.textContent).toContain("library:notice.datapackDeleted");
  });

  it("shows empty state and error alerts for world data packs", async () => {
    commandMock.mockImplementation(async (name) => {
      if (name === "list_worlds") {
        return [{ folderName: "EmptyWorld", name: "Empty World", hardcore: false, sizeBytes: 128 }];
      }
      if (name === "list_screenshots") return [];
      if (name === "list_world_datapacks") return [];
      if (name === "import_world_datapacks") throw { code: "datapack.invalid" };
      return null;
    });

    await act(async () => {
      root.render(createElement(InstanceWorlds, { versionId: "1.21.4" }));
    });
    await flush();

    await act(async () => {
      buttonByText("library:datapacks")!.click();
    });
    await flush();

    expect(container.textContent).toContain("library:noDatapacks");

    pickLauncherPathsMock.mockResolvedValue(["C:\\packs\\bad.zip"]);
    await act(async () => {
      buttonByText("library:importDatapacks")!.click();
    });
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("shell:errors.datapack.invalid");
  });
});
