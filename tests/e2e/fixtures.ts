import type { Page } from "@playwright/test";
import type { WorldMaterial, WorldSceneId } from "../../src/components/world/types";
import type { Instance } from "../../src/lib/launcher";
import type { DownloadTask } from "../../src/features/downloads/useDownloadTasks";

export async function installLauncherFixture(
  page: Page,
  options: {
    profileFailure?: boolean;
    profileDelay?: number;
    emptyProfile?: boolean;
    noAccount?: boolean;
    noInstances?: boolean;
    instanceCount?: number;
    instances?: Partial<Instance>[];
    instanceLoader?: "fabric";
    resourceCreateDelay?: number;
    resourceManifestUnavailable?: boolean;
    resourceGameVersions?: string[];
    firstInstanceName?: string;
    language?: "en-US" | "zh-CN";
    versionDirectoryCount?: number;
    defaultModel?: "classic" | "slim";
    theme?: "dark" | "light" | "system";
    effects?: "lite" | "full";
    worldScene?: WorldSceneId;
    worldMaterial?: WorldMaterial;
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
      language: options.language ?? (options.stress ? "en-US" : "zh-CN"),
      accentColor: "#b4f17a",
      effects: options.effects ?? "full",
      worldScene: options.worldScene ?? "horizon",
      worldMaterial: options.worldMaterial ?? "lattice",
      accentSource: "system",
      soundEnabled: false,
      customBackground: null,
      javaAutoDownload: true,
      defaultSkin: options.defaultModel === "slim" ? "alex" : "steve",
    };
    const installedVersions = Array.from(
      { length: Math.max(0, Math.floor(options.versionDirectoryCount ?? 1)) },
      (_, index) => ({
        id: index === 0 ? "1.21.1" : `fixture-version-${String(index + 1).padStart(3, "0")}`,
        type: "release",
        installed: true,
        launchable: true,
        javaMajor: 21,
      }),
    );
    const originalInstances = options.noInstances ? [] : options.stress ? [
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
    ] : Array.from(
      { length: Math.max(0, Math.floor(options.instanceCount ?? 1)) },
      (_, index) => ({
        id: index === 0 ? "fixture-world" : `fixture-world-${String(index + 1).padStart(3, "0")}`,
        name: index === 0 ? options.firstInstanceName ?? "合成测试世界" : `合成测试世界 ${String(index + 1).padStart(3, "0")}`,
        versionId: "1.21.1",
        gameDirectory: index === 0 ? "C:\\SyntheticFixture\\world" : `C:\\SyntheticFixture\\world-${index + 1}`,
        createdAt: "2026-10-25T08:00:00Z",
        category: "",
        notes: "",
        totalPlayTime: 0,
      }),
    );
    const instances: Instance[] = (options.instances ?? originalInstances).map((instance, index) => ({
      id: index === 0 ? "fixture-world" : `fixture-world-${index + 1}`,
      name: index === 0 ? "合成测试世界" : `合成测试世界 ${index + 1}`,
      versionId: "1.21.1", gameDirectory: `C:\\SyntheticFixture\\world-${index + 1}`,
      createdAt: "2026-01-01T00:00:00Z", category: "", notes: "", totalPlayTime: 0,
      loader: "", loaderVersion: "", ...instance,
      ...(options.instanceLoader ? { loader: "fabric", loaderVersion: "0.16.9", versionId: "fabric-loader-0.16.9-1.21.1" } : {}),
    }));
    for (const instance of instances) {
      if (!installedVersions.some(version => version.id === instance.versionId)) {
        installedVersions.push({ id: instance.versionId, type: "release", installed: true, launchable: true, javaMajor: 21 });
      }
    }
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
    const downloadTasks: DownloadTask[] = options.stress ? [
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
    const cancelledResources = new Set<string>();
    const emit = (event: string, payload: unknown) => callbacks.get(listeners.get(event)!)?.({ event, id: 1, payload: structuredClone(payload) });
    const resourceContext = (versionId: string, instanceId?: string) => {
      const instance = instances.find(item => item.id === instanceId);
      const loader = versionId.startsWith("fabric-loader-") || instance?.loader === "fabric" ? "fabric" : null;
      return { gameVersion: versionId.startsWith("fabric-loader-") ? versionId.split("-").at(-1)! : versionId, loader };
    };
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
              config: { ...config },
              accounts: options.noAccount ? [] : structuredClone(accounts),
              installedVersions: structuredClone(installedVersions),
              instances: structuredClone(instances),
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
          if (name === "get_resource_context")
            return resourceContext(String(args?.versionId ?? ""), args?.instanceId as string | undefined);
          if (name === "list_loader_versions")
            return [{ id: "0.16.9", stable: true, recommended: true }];
          if (name === "resolve_resource_targets") {
            const title = args?.projectId === "P7dR8mSH" ? "Fabric API" : args?.projectId === "sodium" ? "Sodium" : String(args?.projectId);
            const kind = String(args?.resourceType ?? "mod");
            const supportedGames = options.resourceGameVersions ?? ["1.21.1"];
            const manifestUnavailable = Boolean(options.resourceManifestUnavailable);
            const releaseGames = supportedGames.filter(game => game === "1.21.1");
            const candidates = [
              ...instances.map(item => ({ kind: "instance", instanceId: item.id, versionId: item.versionId, name: item.name })),
              // Planner A2: an instance owns its version directory; it is not a
              // second bare-version target with a different install directory.
              ...installedVersions.filter(item => !instances.some(instance => instance.versionId === item.id))
                .map(item => ({ kind: "version", versionId: item.id, name: item.id, instanceId: undefined })),
            ];
            const targets = candidates.map(item => {
              const context = resourceContext(item.versionId, item.instanceId);
              const compatible = supportedGames.includes(context.gameVersion) && (kind !== "mod" || context.loader === "fabric");
              return { ...item, ...context, compatible, reason: compatible ? undefined : !context.loader && kind === "mod" ? "vanilla" : "gameVersionMismatch",
                resourceVersionId: compatible ? "fixture-resource-version" : undefined };
            });
            return {
              projectId: args?.projectId, title, projectType: kind, manifestUnavailable, targets,
              suggestion: !manifestUnavailable && releaseGames.length ? { loader: kind === "resourcepack" ? "vanilla" : "fabric", gameVersion: releaseGames[0], name: title,
                matrix: [{ loader: kind === "resourcepack" ? "vanilla" : "fabric", gameVersions: releaseGames }] } : null,
              unsupportedReason: !targets.some(target => target.compatible)
                ? manifestUnavailable ? "manifestUnavailable" : !releaseGames.length ? "noReleaseVersions" : undefined
                : undefined,
            };
          }
          if (name === "install_resource") {
            const context = resourceContext(String(args?.versionId), args?.instanceId as string | undefined);
            if (args?.resourceType === "mod" && !context.loader) throw { code: "resource.loaderRequired", params: { versionId: args?.versionId } };
            if (!(options.resourceGameVersions ?? ["1.21.1"]).includes(context.gameVersion)) throw { code: "resource.noCompatibleVersion", params: context };
            const target = instances.find(item => item.id === args?.instanceId)?.gameDirectory ?? "C:\\SyntheticFixture";
            return { name: String(args?.projectId), fileName: "fabric-api-fixture.jar", path: target + "\\mods\\fabric-api-fixture.jar" };
          }
          if (name === "create_instance_for_resource") {
            const task: DownloadTask = { id: `fixture-resource-${downloadTasks.length + 1}`, kind: "resource", target: String(args?.projectId),
              label: "合成安装资源", status: "running", stage: "loader-libraries", completed: 1, total: 3, bytesCompleted: 0, bytesTotal: 0,
              message: "合成加载器安装进度", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
            downloadTasks.unshift(task);
            emit("launcher://tasks", downloadTasks);
            emit("launcher://progress", { versionId: "fixture-new", stage: task.stage, completed: 1, total: 3, message: task.message });
            await new Promise(resolve => setTimeout(resolve, options.resourceCreateDelay ?? 100));
            if (cancelledResources.has(task.id)) {
              task.status = "cancelled"; emit("launcher://tasks", downloadTasks);
              throw { code: "download.cancelled", params: {} };
            }
            const loader = String(args?.loader ?? "fabric"), game = String(args?.gameVersion);
            const versionId = loader === "vanilla" ? game : `${loader}-loader-${String(args?.loaderVersion ?? "0.16.9")}-${game}`;
            const instance: Instance = { id: "fixture-created-for-resource", name: String(args?.name), versionId, loader,
              loaderVersion: loader === "vanilla" ? "" : String(args?.loaderVersion ?? "0.16.9"), gameDirectory: "C:\\SyntheticFixture\\instances\\fixture-created-for-resource",
              createdAt: "2026-01-01T00:00:00Z", category: "normal", notes: "", totalPlayTime: 0 };
            instances.push(instance);
            if (!installedVersions.some(item => item.id === versionId)) installedVersions.push({ id: versionId, type: "release", installed: true, launchable: true, javaMajor: 21 });
            task.stage = "resource"; task.completed = 2; task.message = "合成模组安装";
            emit("launcher://progress", { versionId, stage: task.stage, completed: 2, total: 3, message: task.message });
            task.stage = "complete"; task.completed = 3; task.status = "completed"; task.message = "合成安装完成";
            emit("launcher://tasks", downloadTasks);
            return { instance, install: { name: String(args?.name), fileName: "fabric-api-fixture.jar",
              path: instance.gameDirectory + "\\mods\\fabric-api-fixture.jar" } };
          }
          if (name === "cancel_download_task") {
            if (typeof args?.taskId === "string") {
              cancelledResources.add(args.taskId);
              const task = downloadTasks.find(item => item.id === args.taskId);
              if (task) task.status = "cancelled";
              emit("launcher://tasks", downloadTasks);
            }
            return null;
          }
          if (name === "list_download_tasks") return structuredClone(downloadTasks);
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
