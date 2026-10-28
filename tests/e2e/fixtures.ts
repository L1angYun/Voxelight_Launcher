import type { Page } from "@playwright/test";

export async function installLauncherFixture(
  page: Page,
  options: {
    profileFailure?: boolean;
    profileDelay?: number;
    emptyProfile?: boolean;
    noAccount?: boolean;
    noInstances?: boolean;
    defaultModel?: "classic" | "slim";
    theme?: "dark" | "light" | "system";
    effects?: "lite" | "full";
    stress?: boolean;
    launchDelay?: number;
  } = {},
) {
  await page.addInitScript((options) => {
    const texture = (color: string, cape = false) => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = cape ? 32 : 64;
      const context = canvas.getContext("2d")!;
      context.fillStyle = color;
      context.fillRect(0, 0, 64, canvas.height);
      if (!cape) {
        context.clearRect(32, 0, 32, 16);
        context.fillStyle = "#122638";
        context.fillRect(9, 10, 2, 2);
        context.fillRect(13, 10, 2, 2);
      }
      return canvas.toDataURL("image/png");
    };
    const skins = {
      classic: texture("#18d8ed"),
      slim: texture("#f68024"),
      saved: texture("#8e42db"),
      cape: texture("#ec29b7", true),
      default: texture("#478b48"),
    };
    const accounts = [
      {
        id: "fixture-classic",
        username: "CyanFixture",
        uuid: "11111111111111111111111111111111",
        type: "microsoft",
        isSelected: true,
        skinUrl: skins.saved,
        skinModel: "slim",
      },
      {
        id: "fixture-slim",
        username: "AmberFixture",
        uuid: "22222222222222222222222222222222",
        type: "authlib",
        isSelected: false,
        skinUrl: null,
        skinModel: "classic",
      },
      {
        id: "fixture-unavailable",
        username: "UnavailableFixture",
        uuid: "33333333333333333333333333333333",
        type: "microsoft",
        isSelected: false,
        skinUrl: null,
        skinModel: "classic",
      },
    ];
    if (options.profileFailure) accounts[0].skinUrl = null as unknown as string;
    if (options.stress) {
      accounts[0].username = "LongPlayer_12345";
      accounts[1].username = "Jox";
      accounts[1].skinUrl = "data:image/png;base64,YnJva2Vu";
    }
    const config = {
      gameDirectory: "C:\\SyntheticFixture",
      javaPath: "",
      maxMemoryMb: 4096,
      jvmArguments: "",
      versionIsolation: true,
      theme: options.theme ?? "dark",
      downloadConcurrency: 6,
      microsoftClientId: "",
      downloadLimitKib: 0,
      downloadSource: "official",
      screenWidth: 1280,
      screenHeight: 720,
      language: options.stress ? "en-US" : "zh-CN",
      accentColor: "#b4f17a",
      effects: options.effects ?? "full",
      accentSource: "system",
      soundEnabled: false,
      customBackground: null,
      javaAutoDownload: true,
      defaultSkin: options.defaultModel === "slim" ? "alex" : "steve",
    };
    const installedVersions = [
      {
        id: "1.21.1",
        type: "release",
        installed: true,
        launchable: true,
        javaMajor: 21,
      },
    ];
    const instances = options.noInstances ? [] : options.stress ? [
      {
        id: "long-instance",
        name: "Christopher Alexander Montgomery III's Shared Fabric Survival World With An Exceptionally Long But Plausible Name",
        versionId: "1.21.1",
        gameDirectory: "C:\\SyntheticFixture\\instances\\christopher-alexander-montgomery-shared-survival-world-with-a-long-directory-name",
        createdAt: "2026-10-25T08:00:00Z",
        category: "Long-term multiplayer building and automation",
        notes: "",
        totalPlayTime: 0,
        loader: "fabric",
        loaderVersion: "0.16.9",
      },
      {
        id: "short-instance",
        name: "Jo",
        versionId: "1.21.1",
        gameDirectory: "C:\\SyntheticFixture\\jo",
        createdAt: "2026-10-24T08:00:00Z",
        category: "",
        notes: "",
        totalPlayTime: 0,
        loader: "vanilla",
        loaderVersion: "",
      },
    ] : [
      {
        id: "fixture-world",
        name: "合成测试世界",
        versionId: "1.21.1",
        gameDirectory: "C:\\SyntheticFixture\\world",
        createdAt: "2026-10-25T08:00:00Z",
        category: "",
        notes: "",
        totalPlayTime: 0,
      },
    ];
    const history = Array.from({ length: 198 }, (_, index) => ({
      id: `history-${index}`,
      kind: "install",
      target: `1.20.${(index % 4) + 1}`,
      label: "Legacy task label",
      status: "completed",
      stage: "complete",
      completed: 64,
      total: 64,
      bytesCompleted: 81000000,
      bytesTotal: 81000000,
      message: "等待执行",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }));
    const downloadTasks = options.stress ? [
      {
        id: "task-long",
        kind: "resource",
        target: "Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf",
        label: "Legacy task label",
        status: "running",
        stage: "download",
        completed: 642,
        total: 1284,
        bytesCompleted: 6172839,
        bytesTotal: 12345678,
        message: "等待执行",
        createdAt: "2026-10-25T08:00:00Z",
        updatedAt: "2026-10-25T08:12:00Z",
      },
      {
        id: "task-failed",
        kind: "install",
        target: "fabric-loader-0.16.9-1.21.1",
        label: "Legacy task label",
        status: "failed",
        stage: "failed",
        completed: 0,
        total: 0,
        bytesCompleted: 0,
        bytesTotal: 0,
        message: "等待执行",
        error: "Synthetic diagnostic",
        createdAt: "2026-10-24T08:00:00Z",
        updatedAt: "2026-10-24T08:18:00Z",
      },
      ...history,
    ] : [];
    const calls: { name: string; args?: Record<string, unknown> }[] = [];
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<string, number>();
    let nextCallback = 0;
    const profile = (id: string) => {
      const account = accounts.find((item) => item.id === id)!;
      return {
        id: account.uuid,
        name: account.username,
        skins: [
          {
            id: "inactive",
            state: "INACTIVE",
            url: skins.saved,
            variant: "slim",
          },
          {
            id: "active",
            state: "ACTIVE",
            url: id === "fixture-slim" ? skins.slim : skins.classic,
            variant: id === "fixture-slim" ? "slim" : "classic",
          },
        ],
        capes: [
          { id: "inactive", state: "INACTIVE", url: skins.saved },
          {
            id: "fixture-cape",
            state: "ACTIVE",
            url: skins.cape,
            alias: "Synthetic cape",
          },
        ],
      };
    };
    Object.assign(window, {
      __appearanceFixtures: { skins, calls },
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (value: unknown) => void) => {
          callbacks.set(++nextCallback, callback);
          return nextCallback;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        convertFileSrc: (path: string) => path,
        invoke: async (name: string, args?: Record<string, unknown>) => {
          calls.push({ name, args });
          if (name === "plugin:event|listen") {
            listeners.set(String(args?.event), Number(args?.handler));
            return nextCallback;
          }
          if (name === "bootstrap")
            return {
              config,
              accounts: options.noAccount ? [] : accounts,
              installedVersions,
              instances,
              capabilities: {},
            };
          if (name === "get_default_skin") {
            const id = args?.skin === "alex" ? "alex" : "steve";
            return {
              id,
              name: id === "alex" ? "Alex" : "Steve",
              dataUrl: skins.default,
              model: id === "alex" ? "slim" : "classic",
              description: "程序生成的测试默认预览，不是官方角色素材。",
            };
          }
          if (name === "get_player_profile") {
            if (options.profileDelay)
              await new Promise((resolve) =>
                setTimeout(resolve, options.profileDelay),
              );
            if (
              options.profileFailure ||
              args?.accountId === "fixture-unavailable"
            )
              throw new Error("Synthetic profile service unavailable");
            const value = profile(String(args?.accountId));
            return options.emptyProfile
              ? { ...value, skins: [], capes: [] }
              : value;
          }
          if (name === "select_account") {
            for (const account of accounts)
              account.isSelected = account.id === args?.accountId;
            return null;
          }
          if (name === "save_config") {
            Object.assign(config, args?.config);
            return config;
          }
          if (name === "list_versions")
            return {
              latestRelease: "1.21.1",
              latestSnapshot: "",
              versions: [],
            };
          if (name === "get_service_status")
            return { curseforgeConfigured: false };
          if (name === "list_download_tasks") return downloadTasks;
          if (name === "list_servers" && options.stress)
            return [{
              index: 0,
              name: "Community Survival & Creative Building Server — Europe West With A Very Long But Valid Name",
              address: "ops@sub.department.region.example.co.uk:25565",
              hideAddress: false,
            }];
          if (name === "list_managed_servers")
            return [
              {
                id: "fixture-server",
                name: options.stress ? "Community Survival & Creative Building Server — Europe West With A Very Long But Valid Name" : "合成测试服务端",
                versionId: "1.21.1",
                createdAt: "2026-01-01T00:00:00Z",
                directory: "C:\\SyntheticFixture\\server",
                settings: {
                  port: 25565,
                  maxPlayers: 20,
                  onlineMode: true,
                  whitelist: false,
                  motd: "Synthetic server",
                  difficulty: "normal",
                  gamemode: "survival",
                  viewDistance: 10,
                  maxMemoryMb: 2048,
                  bindAddress: "",
                },
                eulaAccepted: false,
                eulaUrl: "https://aka.ms/MinecraftEULA",
                installed: true,
                status: "stopped",
                pid: null,
                exitCode: null,
                error: null,
                javaMajor: 21,
              },
            ];
          if (name === "check_resource_updates") return [];
          if (name === "get_crash_diagnosis") return null;
          if (name === "launch_game") {
            callbacks.get(listeners.get("launcher://progress")!)?.({
              event: "launcher://progress",
              id: 1,
              payload: {
                versionId: "1.21.1",
                stage: "assets",
                completed: 37,
                total: 100,
                message: "合成进度 37%",
              },
            });
            await new Promise((resolve) => setTimeout(resolve, options.launchDelay ?? 1600));
            return { pid: 12345 };
          }
          if (name.startsWith("list_") || name === "read_managed_server_logs")
            return [];
          return null;
        },
      },
    });
  }, options);
}
