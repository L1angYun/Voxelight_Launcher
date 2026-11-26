import type { Page } from "@playwright/test";
import type { WorldMaterial, WorldSceneId } from "../../src/components/world/types";
import { appearanceFields, type Instance } from "../../src/lib/launcher";
import type { DownloadTask } from "../../src/features/downloads/useDownloadTasks";
import type { LocalResource } from "../../src/features/library/types";
import packageJson from "../../package.json" with { type: "json" };

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
    queuedResourceBehindSameProject?: boolean;
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
    manualLaunchCompletion?: boolean;
    settingsOperationLocked?: boolean;
    /** Defaults to true so the first-run tour never covers unrelated specs. */
    tourCompleted?: boolean;
    /** A configured home image path; the fixture answers with a 1×1 PNG. */
    customBackground?: string;
    /** Files returned by list_local_resources for the first instance's resourcepacks. */
    localResources?: Partial<LocalResource>[];
    /** A newer stable release the update check finds (none: this build is the newest). */
    launcherUpdate?: { latestVersion: string };
  } = {},
) {
  await page.addInitScript(({ options, appearanceKeys, appVersion }) => {
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
      proxyMode: "system", proxyScheme: "http", proxyHost: "", proxyPort: 0,
      gameProxyMode: "system",
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
      customBackground: options.customBackground ?? null,
      javaAutoDownload: true,
      defaultSkin: options.defaultModel === "slim" ? "alex" : "steve",
      checkForUpdates: true,
      updateSource: "auto",
      updateChannel: "stable",
      tourCompleted: options.tourCompleted ?? true,
      assistantProvider: "openai",
      assistantBaseUrl: "",
      assistantModel: "",
      assistantPermission: "readOnly",
      assistantProactive: true,
      assistantMcpPort: 25590,
    };
    let assistantApiKeyConfigured = false;
    let mcpRunning = false;
    let mcpPort = 25590;
    let mcpToken = "synthetic-mcp-token-000001";
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
    const localResourceKey = (args?: Record<string, unknown>) =>
      `${String(args?.resourceType ?? "resourcepack")}\u0000${String(args?.instanceId ?? "")}\u0000${String(args?.versionId ?? "")}`;
    const localResourceSets = new Map<string, LocalResource[]>();
    if (options.localResources?.length) {
      const first = instances[0];
      const resourceType = "resourcepack";
      const files = options.localResources.map((resource, index) => {
        const fileName = resource.fileName ?? `fixture-resource-${index + 1}.zip`;
        return {
          ...resource,
          name: resource.name ?? fileName.replace(/\.disabled$/, "").replace(/\.[^.]+$/, ""),
          fileName,
          path: resource.path ?? `C:\\SyntheticFixture\\resourcepacks\\${fileName}`,
          enabled: resource.enabled ?? true,
          size: resource.size ?? 1024,
        };
      });
      localResourceSets.set(localResourceKey({
        resourceType,
        instanceId: first?.id ?? "fixture-world",
        versionId: first?.versionId ?? "1.21.1",
      }), files);
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
        // As the backend computes it for an install row without a payload.
        retryable: true,
      },
      ...history,
    ] : [];
    const calls: { name: string; args?: Record<string, unknown> }[] = [];
    let settingsOperationLocked = options.settingsOperationLocked ?? false;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<string, Map<number, number>>();
    const cancelledTasks = new Set<string>();
    let finishFixtureLaunch = () => {};
    const manualLaunchCompletion = options.manualLaunchCompletion
      ? new Promise<void>(resolve => { finishFixtureLaunch = resolve; })
      : null;
    if (manualLaunchCompletion) {
      Object.defineProperty(window, "__completeFixtureLaunch", { value: finishFixtureLaunch });
    }
    const runningGames = new Map<string, {
      gameId: string; pid: number; versionId: string; instanceId: string | null;
      gameDirectory: string; startedAt: string;
    }>();
    const exportPreviews = new Map<string, { instanceId: string; options: Record<string, boolean> }>();
    let previewSequence = 0;
    const resourceReservations = new Map<string, Record<string, unknown>>();
    let nextResourceId = 0;
    let importedManagedSequence = 0;
    const importedManagedServers: Record<string, unknown>[] = [];
    const managedSettings = {
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
    };
    const launchReservations = new Map<string, { versionId: string; instanceId?: string }>();
    const cancelLaunches = new Map<string, () => void>();
    let taskRevision = 0, nextLaunchId = 0;
    const taskSnapshot = () => ({ revision: taskRevision, tasks: structuredClone(downloadTasks) });
    const publishTasks = () => { ++taskRevision; emit("launcher://tasks", taskSnapshot()); };
    const emit = (event: string, payload: unknown) => {
      for (const [id, callbackId] of listeners.get(event) ?? []) {
        callbacks.get(callbackId)?.({ event, id, payload: structuredClone(payload) });
      }
    };
    (window as unknown as { __VX_EMIT__?: (event: string, payload: unknown) => void }).__VX_EMIT__ = emit;
    const resourceTask = (id: string, project: string, status: DownloadTask["status"]): DownloadTask => ({
      id, kind: "resource", target: project, label: "合成安装资源", status, stage: "queued",
      completed: 0, total: 0, bytesCompleted: 0, bytesTotal: 0, message: "",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    });
    const claimResource = (args: Record<string, unknown> | undefined, source: string, mode: "existing" | "create") => {
      const taskId = String(args?.taskId);
      if (cancelledTasks.has(taskId)) throw { code: "download.cancelled", params: {} };
      const request = resourceReservations.get(taskId);
      const target = request?.target as Record<string, unknown> | undefined;
      const fields = mode === "create" ? ["gameVersion", "loader", "loaderVersion", "name", "resourceVersionId", "fileId"] : ["versionId", "instanceId", "fileId", "resourceVersionId"];
      if (request?.source !== source || request?.projectId !== args?.projectId ||
        request?.resourceType !== args?.resourceType || target?.mode !== mode ||
        fields.some(field => target?.[field] !== args?.[field])) throw { code: "download.notFound", params: {} };
      resourceReservations.delete(taskId);
      return downloadTasks.find(item => item.id === taskId)!;
    };
    const finishResource = (task: DownloadTask, status: "completed" | "failed") => {
      task.status = status;
      task.stage = status === "completed" ? "complete" : "failed";
      publishTasks();
    };
    const resourceContext = (versionId: string, instanceId?: string) => {
      const instance = instances.find(item => item.id === instanceId);
      const loader = versionId.startsWith("fabric-loader-") || instance?.loader === "fabric" ? "fabric" : null;
      return { gameVersion: versionId.startsWith("fabric-loader-") ? versionId.split("-").at(-1)! : versionId, loader };
    };
    let nextCallback = 0, nextListener = 0;
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
      __appearanceFixtures: { skins, calls, releaseSettingsOperation: () => { settingsOperationLocked = false; } },
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
            const event = String(args?.event), handler = Number(args?.handler);
            if (!callbacks.has(handler)) throw new Error("Unregistered fixture callback");
            const id = ++nextListener;
            const handlers = listeners.get(event) ?? new Map<number, number>();
            handlers.set(id, handler);
            listeners.set(event, handlers);
            return id;
          }
          if (name === "plugin:event|unlisten") {
            const event = String(args?.event);
            const handlers = listeners.get(event);
            const id = Number(args?.eventId);
            const handler = handlers?.get(id);
            if (handler !== undefined) callbacks.delete(handler);
            handlers?.delete(id);
            if (!handlers?.size) listeners.delete(event);
            return null;
          }
          if (name === "choose_launcher_path") {
            const files: Record<string, string> = {
              gameDirectory: "C:\\SyntheticFixture\\game", java: "C:\\SyntheticFixture\\java.exe",
              instanceIcon: "C:\\SyntheticFixture\\icon.png", skin: "C:\\SyntheticFixture\\skin.png",
              background: "C:\\SyntheticFixture\\background.png", presetRead: "C:\\SyntheticFixture\\preset.json",
              presetWrite: "C:\\SyntheticFixture\\preset.json", localResources: "C:\\SyntheticFixture\\example.jar",
              worldRead: "C:\\SyntheticFixture\\fixture-world.zip", worldWrite: "C:\\SyntheticFixture\\fixture-world.zip",
              packRead: "C:\\SyntheticFixture\\fixture-pack.zip", packWrite: "C:\\SyntheticFixture\\fixture-pack.mrpack",
              instanceArchive: "C:\\SyntheticFixture\\backup.zip", diagnostics: "C:\\SyntheticFixture\\diagnostic.txt",
              serverJar: "C:\\SyntheticFixture\\paper.jar", serverFolder: "C:\\SyntheticFixture\\server-folder",
            };
            const path = files[String(args?.purpose)];
            if (!path) throw new Error("Fixture received an unknown native path purpose");
            return [path];
          }
          if (name === "plan_modrinth_export") {
            const instanceId = String(args?.instanceId);
            if (!instances.some(instance => instance.id === instanceId)) throw new Error("Fixture instance does not exist");
            const options = (args?.options ?? {}) as Record<string, boolean>;
            const fingerprint = `synthetic-share-${++previewSequence}`;
            exportPreviews.set(fingerprint, { instanceId, options: structuredClone(options) });
            return {
              downloadReferences: ["mods/synthetic.jar"],
              bundledFiles: options.includeConfigs ? ["modrinth.index.json", "overrides/config/example.toml"] : ["modrinth.index.json"],
              excludedFiles: options.includeConfigs ? [] : [{ path: "config/example.toml", reason: "notSelected" }],
              fingerprint,
            };
          }
          if (name === "export_modrinth_modpack") {
            const plan = exportPreviews.get(String(args?.confirmedFingerprint));
            const options = (args?.options ?? {}) as Record<string, boolean>;
            const keys = new Set([...Object.keys(options), ...Object.keys(plan?.options ?? {})]);
            if (!plan || plan.instanceId !== args?.instanceId || [...keys].some(key => options[key] !== plan.options[key])) {
              throw { code: "instance.exportPreviewChanged", params: {}, detail: "instance.exportPreviewChanged" };
            }
            return { path: String(args?.outputPath), downloadFiles: 1, overrideFiles: plan.options.includeConfigs ? 1 : 0, warnings: [] };
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
            if (!accounts.some((account) => account.id === args?.accountId)) throw new Error("Fixture account does not exist");
            for (const account of accounts)
              account.isSelected = account.id === args?.accountId;
            return structuredClone(accounts);
          }
          if (name === "save_appearance_config") {
            Object.assign(config, args?.patch);
            return { ...config };
          }
          // Self-update (updates::*): the check finds options.launcherUpdate, else this build.
          if (name === "get_launcher_update_state") return { currentVersion: appVersion, check: null, download: "idle", staged: null };
          if (name === "check_launcher_update") {
            const latest = options.launcherUpdate?.latestVersion ?? appVersion;
            const newer = latest !== appVersion;
            return {
              currentVersion: appVersion, latestVersion: latest, status: newer ? "newer" : "current", source: "github",
              releaseUrl: `https://github.com/L1angYun/Voxelight_Launcher/releases/tag/v${latest}`,
              notes: newer ? `Synthetic notes for ${latest}` : null, installerSize: newer ? 4096 : null,
            };
          }
          if (name === "set_launcher_update_preferences") {
            Object.assign(config, {
              checkForUpdates: args?.checkForUpdates === true,
              updateSource: String(args?.updateSource),
              ...(typeof args?.updateChannel === "string" ? { updateChannel: args.updateChannel } : {}),
            });
            return { ...config };
          }
          if (name === "download_launcher_update") {
            const latest = options.launcherUpdate?.latestVersion ?? appVersion;
            emit("launcher://update-progress", { downloaded: 4096, total: 4096 });
            return { version: latest, fileName: `VoxelightLauncher-${latest}-x64-setup.exe`, size: 4096 };
          }
          // The real launcher exits here and the helper runs the installer.
          if (name === "install_launcher_update_and_exit") return new Promise(() => {});
          if (name === "cancel_launcher_update") return null;
          if (name === "save_config") {
            if (settingsOperationLocked) throw { code: "config.busy", params: {} };
            const appearance = args?.preserveAppearance === true
              ? Object.fromEntries(appearanceKeys.map((key) => [key, config[key]]))
              : {};
            const tourCompleted = config.tourCompleted;
            Object.assign(config, args?.config, appearance);
            // Like the backend, a whole-config save never changes this flag.
            config.tourCompleted = tourCompleted;
            return { ...config };
          }
          if (name === "set_tour_completed") {
            config.tourCompleted = args?.completed === true;
            return { ...config };
          }
          if (name === "reset_launcher_state") {
            Object.assign(config, {
              javaPath: "",
              maxMemoryMb: 4096,
              jvmArguments: "",
              versionIsolation: true,
              theme: "system",
              downloadConcurrency: 6,
              microsoftClientId: "",
              proxyMode: "system",
              proxyScheme: "http",
              proxyHost: "",
              proxyPort: 0,
              gameProxyMode: "system",
              downloadLimitKib: 0,
              downloadSource: "official",
              screenWidth: 1280,
              screenHeight: 720,
              language: "system",
              accentColor: "#b4f17a",
              effects: "full",
              worldScene: "horizon",
              worldMaterial: "lattice",
              accentSource: "system",
              soundEnabled: false,
              customBackground: null,
              javaAutoDownload: true,
              defaultSkin: "steve",
              checkForUpdates: true,
              updateSource: "auto",
              updateChannel: "stable",
              tourCompleted: false,
              assistantProvider: "openai",
              assistantBaseUrl: "",
              assistantModel: "",
              assistantPermission: "readOnly",
              assistantProactive: true,
              assistantMcpPort: 25590,
            });
            accounts.length = 0;
            instances.length = 0;
            downloadTasks.length = 0;
            assistantApiKeyConfigured = false;
            mcpRunning = false;
            return { ...config };
          }
          if (name === "detect_java") {
            return [{ path: "C:\\SyntheticFixture\\java.exe", version: "21.0.5", major: 21 }];
          }
          if (name === "detect_local_proxies") {
            return { systemProxy: null, autoConfigUrl: null, candidates: [] };
          }
          if (name === "get_memory_overview") {
            return { totalMb: 16384, availableMb: 10240, recommendedMb: 4096, effectiveMaxMb: 4096, mode: "auto" };
          }
          if (name === "add_offline_account") {
            const username = String(args?.username ?? "Player");
            const added = {
              id: `offline-${accounts.length + 1}`,
              username,
              uuid: "44444444444444444444444444444444",
              type: "offline",
              isSelected: true,
              skinUrl: null,
              skinModel: "classic",
            };
            for (const a of accounts) a.isSelected = false;
            accounts.push(added);
            return structuredClone(added);
          }
          if (name === "list_versions")
            return {
              latestRelease: "1.21.1",
              latestSnapshot: "",
              versions: [],
            };
          if (name === "get_service_status")
            return { curseforgeConfigured: false, microsoftConfigured: false };
          if (name === "get_launcher_background")
            return config.customBackground ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" : null;
          if (name === "get_resource_context")
            return resourceContext(String(args?.versionId ?? ""), args?.instanceId as string | undefined);
          if (name === "list_loader_versions")
            return [{ id: "0.16.9", stable: true, recommended: true }];
          if (name === "install_optifine_installer") {
            const id = String(args?.instanceId ?? "");
            const versionId = "1.21.1-OptiFine_HD_U_J1";
            if (!installedVersions.some((v) => v.id === versionId)) {
              installedVersions.push({ id: versionId, type: "release", installed: true, launchable: true, javaMajor: 21 });
            }
            if (id) {
              const target = instances.find((item) => item.id === id);
              if (target) {
                target.loader = "optifine";
                target.loaderVersion = "HD_U_J1";
                target.versionId = versionId;
              }
            }
            return { versionId, loader: "optifine", loaderVersion: "HD_U_J1" };
          }
          if (name === "change_instance_loader") {
            const id = String(args?.instanceId ?? "");
            const targetLoader = String(args?.loader ?? "vanilla");
            const targetLoaderVersion = targetLoader === "vanilla" ? "" : String(args?.loaderVersion ?? "0.16.9");
            const target = instances.find((item) => item.id === id);
            if (!target) throw { code: "instance.notFound", params: {} };
            const ctx = resourceContext(target.versionId, target.id);
            const nextVersionId = targetLoader === "vanilla"
              ? ctx.gameVersion
              : `${targetLoader}-loader-${targetLoaderVersion}-${ctx.gameVersion}`;
            target.loader = targetLoader;
            target.loaderVersion = targetLoaderVersion;
            target.versionId = nextVersionId;
            if (!installedVersions.some((v) => v.id === nextVersionId)) {
              installedVersions.push({ id: nextVersionId, type: "release", installed: true, launchable: true, javaMajor: 21 });
            }
            return structuredClone(target);
          }
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
          if (name === "reserve_resource_task") {
            const request = args?.request as Record<string, unknown>;
            const id = "fixture-resource-" + ++nextResourceId;
            const projectId = String(request.projectId);
            if (options.queuedResourceBehindSameProject && !downloadTasks.some(task => task.id === "fixture-other-resource")) {
              downloadTasks.unshift(resourceTask("fixture-other-resource", projectId, "running"));
            }
            resourceReservations.set(id, structuredClone(request));
            downloadTasks.unshift(resourceTask(id, projectId, "queued"));
            publishTasks();
            return id;
          }
          if (name === "install_resource" || name === "install_curseforge_resource") {
            const task = claimResource(args, name === "install_resource" ? "modrinth" : "curseforge", "existing");
            task.status = "running";
            publishTasks();
            try {
              const context = resourceContext(String(args?.versionId), args?.instanceId as string | undefined);
              if (args?.resourceType === "mod" && !context.loader) throw { code: "resource.loaderRequired", params: { versionId: args?.versionId } };
              if (!(options.resourceGameVersions ?? ["1.21.1"]).includes(context.gameVersion)) throw { code: "resource.noCompatibleVersion", params: context };
              const target = instances.find(item => item.id === args?.instanceId)?.gameDirectory ?? "C:\\SyntheticFixture";
              finishResource(task, "completed");
              return { name: String(args?.projectId), fileName: "fabric-api-fixture.jar", path: target + "\\mods\\fabric-api-fixture.jar" };
            } catch (error) {
              finishResource(task, "failed");
              throw error;
            }
          }
          if (name === "create_instance_for_resource") {
            const task = claimResource(args, "modrinth", "create");
            const cancellation = new Promise<never>((_resolve, reject) => {
              cancelLaunches.set(task.id, () => reject({ code: "download.cancelled", params: {} }));
            });
            try {
              if (options.queuedResourceBehindSameProject) await cancellation;
              Object.assign(task, { status: "running", stage: "loader-libraries", completed: 1, total: 3, message: "合成加载器安装进度" });
              publishTasks();
              emit("launcher://progress", { taskId: task.id, operation: task.kind, versionId: "fixture-new", stage: task.stage, completed: 1, total: 3, bytesCompleted: 0, bytesTotal: 0, message: task.message });
              await Promise.race([cancellation, new Promise(resolve => setTimeout(resolve, options.resourceCreateDelay ?? 100))]);
            } finally {
              cancelLaunches.delete(task.id);
            }
            const loader = String(args?.loader ?? "fabric"), game = String(args?.gameVersion);
            const versionId = loader === "vanilla" ? game : `${loader}-loader-${String(args?.loaderVersion ?? "0.16.9")}-${game}`;
            const instance: Instance = { id: "fixture-created-for-resource", name: String(args?.name), versionId, loader,
              loaderVersion: loader === "vanilla" ? "" : String(args?.loaderVersion ?? "0.16.9"), gameDirectory: "C:\\SyntheticFixture\\instances\\fixture-created-for-resource",
              createdAt: "2026-01-01T00:00:00Z", category: "normal", notes: "", totalPlayTime: 0 };
            instances.push(instance);
            if (!installedVersions.some(item => item.id === versionId)) installedVersions.push({ id: versionId, type: "release", installed: true, launchable: true, javaMajor: 21 });
            task.stage = "resource"; task.completed = 2; task.message = "合成模组安装";
            emit("launcher://progress", { taskId: task.id, operation: task.kind, versionId, stage: task.stage, completed: 2, total: 3, bytesCompleted: 0, bytesTotal: 0, message: task.message });
            task.stage = "complete"; task.completed = 3; task.status = "completed"; task.message = "合成安装完成";
            publishTasks();
            return { instance, install: { name: String(args?.name), fileName: "fabric-api-fixture.jar",
              path: instance.gameDirectory + "\\mods\\fabric-api-fixture.jar" } };
          }
          if (name === "cancel_download_task" || name === "set_download_paused") {
            const taskId = args?.taskId;
            if (typeof taskId !== "string" || !taskId) throw { code: "download.notFound", params: {} };
            const task = downloadTasks.find(item => item.id === taskId);
            if (!task) throw { code: "download.notFound", params: {} };
            if (name === "cancel_download_task" && ["queued", "running", "paused"].includes(task.status)) {
              cancelledTasks.add(taskId);
              resourceReservations.delete(taskId);
              task.status = "cancelled";
              task.stage = "cancelled";
              cancelLaunches.get(taskId)?.();
              publishTasks();
            } else if (name === "set_download_paused" && ["running", "paused"].includes(task.status)) {
              task.status = args?.paused ? "paused" : "running";
              publishTasks();
            }
            return taskSnapshot();
          }
          if (name === "list_download_tasks") return taskSnapshot();
          if (name === "retry_failed_downloads") {
            const ids: string[] = [];
            let skipped = 0;
            for (const task of [...downloadTasks]) {
              if (task.status !== "failed") continue;
              if (!task.retryable) { skipped += 1; continue; }
              const id = `retry-${downloadTasks.length + 1}`;
              ids.push(id);
              downloadTasks.push({ ...task, id, status: "queued", stage: "queued", retryable: false });
            }
            publishTasks();
            return { ids, skipped };
          }
          if (name === "clear_unfinished_downloads") {
            if (downloadTasks.some(item => item.status === "running" || item.status === "queued")) {
              throw { code: "download.busy", params: {} };
            }
            const before = downloadTasks.length;
            for (let i = downloadTasks.length - 1; i >= 0; i--) {
              if (downloadTasks[i].status === "failed" || downloadTasks[i].status === "cancelled") {
                downloadTasks.splice(i, 1);
              }
            }
            publishTasks();
            return { tasks: before - downloadTasks.length, bytes: 0 };
          }
          if (name === "list_servers" && options.stress)
            return [{
              index: 0,
              name: "Community Survival & Creative Building Server — Europe West With A Very Long But Valid Name",
              address: "ops@sub.department.region.example.co.uk:25565",
              hideAddress: false,
              snapshot: "stress-server-0",
            }];
          if (name === "inspect_server_import") {
            const kind = args?.kind === "folder" ? "folder" : "jar";
            const path = String(args?.path ?? "");
            const fileName = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "server.jar";
            if (kind === "jar") return {
              kind,
              software: "Paper",
              minecraftVersion: "1.21.1",
              jars: [fileName],
              details: [{ jar: fileName, software: "Paper", minecraftVersion: "1.21.1" }],
              defaultJar: fileName,
              totalBytes: 8388608,
              fileCount: 1,
              unsupported: null,
            };
            return {
              kind,
              software: "Paper",
              minecraftVersion: "1.21.1",
              jars: ["paper.jar", "paper-original.jar"],
              details: [
                { jar: "paper.jar", software: "Paper", minecraftVersion: "1.21.1" },
                { jar: "paper-original.jar", software: "Paper", minecraftVersion: "1.21.1" },
              ],
              defaultJar: "paper.jar",
              totalBytes: 16777216,
              fileCount: 3,
              unsupported: null,
            };
          }
          if (name === "import_managed_server") {
            const request = (args?.request ?? {}) as Record<string, unknown>;
            const imported = {
              id: `fixture-imported-server-${++importedManagedSequence}`,
              name: String(request.name ?? "Imported fixture server"),
              versionId: String(request.versionId ?? "1.21.1"),
              createdAt: "2026-01-01T00:00:00Z",
              directory: `C:\\SyntheticFixture\\servers\\fixture-imported-server-${importedManagedSequence}`,
              settings: { ...managedSettings },
              eulaAccepted: false,
              eulaUrl: "https://aka.ms/MinecraftEULA",
              installed: true,
              status: "stopped",
              pid: null,
              exitCode: null,
              error: null,
              javaMajor: 21,
              source: "imported",
              software: "Paper",
              jar: String(request.jar ?? "paper.jar"),
              argsFile: (request.argsFile as string | null | undefined) ?? null,
            };
            importedManagedServers.unshift(imported);
            return structuredClone(imported);
          }
          if (name === "list_managed_servers") {
            const vanilla = {
              id: "fixture-server",
              name: options.stress ? "Community Survival & Creative Building Server — Europe West With A Very Long But Valid Name" : "合成测试服务端",
              versionId: "1.21.1",
              createdAt: "2026-01-01T00:00:00Z",
              directory: "C:\\SyntheticFixture\\server",
              settings: { ...managedSettings },
              eulaAccepted: false,
              eulaUrl: "https://aka.ms/MinecraftEULA",
              installed: true,
              status: "stopped",
              pid: null,
              exitCode: null,
              error: null,
              javaMajor: 21,
              source: "vanilla",
              software: null,
              jar: null,
              argsFile: null,
            };
            return structuredClone([...importedManagedServers, vanilla]);
          }
          if (name === "check_resource_updates") return { updates: [], curseforgeSkipped: false };
          if (name === "diagnose_instance") return { kind: "empty", logPath: null, excerpt: "" };
          if (name === "read_game_log") return { path: null, lines: [], truncated: false };
          if (name === "get_system_appearance") return {
            accentColor: "#b4f17a", animationsEnabled: true, advancedEffectsEnabled: true, locale: options.language ?? "zh-CN",
          };
          if (name === "cancel_auth_login") return null;
          if (name === "list_running_games") return structuredClone([...runningGames.values()]);
          if (name === "reserve_launch_task") {
            const id = `fixture-launch-${++nextLaunchId}`;
            const versionId = String(args?.versionId), instanceId = args?.instanceId as string | undefined;
            const time = new Date().toISOString();
            launchReservations.set(id, { versionId, instanceId });
            downloadTasks.unshift({ id, kind: "launch", target: versionId,
              label: "合成启动", status: "queued", stage: "queued", completed: 0, total: 0, bytesCompleted: 0, bytesTotal: 0,
              message: "", createdAt: time, updatedAt: time });
            publishTasks();
            return id;
          }
          if (name === "launch_game") {
            const taskId = String(args?.taskId);
            const reservation = launchReservations.get(taskId);
            if (cancelledTasks.has(taskId)) throw { code: "download.cancelled", params: {} };
            if (!reservation || reservation.versionId !== args?.versionId || reservation.instanceId !== args?.instanceId) {
              throw { code: "download.notFound", params: {} };
            }
            launchReservations.delete(taskId);
            const task = downloadTasks.find(item => item.id === taskId)!;
            task.status = "running"; task.stage = "assets"; task.completed = 37; task.total = 100;
            publishTasks();
            emit("launcher://progress", { taskId, operation: "launch", versionId: reservation.versionId, stage: task.stage,
              completed: task.completed, total: task.total, bytesCompleted: 0, bytesTotal: 0, message: task.message });
            // Retain the original timer even after cancel to ensure its late resolve has no launch effect.
            const work = manualLaunchCompletion ?? new Promise<void>(resolve => setTimeout(resolve, options.launchDelay ?? 1600));
            const cancellation = new Promise<never>((_resolve, reject) => {
              cancelLaunches.set(taskId, () => reject({ code: "download.cancelled", params: {} }));
            });
            try { await Promise.race([work, cancellation]); }
            finally { cancelLaunches.delete(taskId); }
            task.status = "completed"; task.stage = "complete"; task.completed = task.total;
            publishTasks();
            const gameId = `fixture-game-${taskId}`;
            const instance = instances.find(candidate => candidate.id === reservation.instanceId);
            const gameDirectory = instance?.gameDirectory ?? (config.versionIsolation
              ? `${config.gameDirectory}\\versions\\${reservation.versionId}` : config.gameDirectory);
            const game = { gameId, pid: 12345, versionId: reservation.versionId,
              instanceId: reservation.instanceId ?? null, gameDirectory, startedAt: new Date().toISOString() };
            runningGames.set(gameId, game);
            emit("launcher://games", [...runningGames.values()]);
            return { gameId, pid: game.pid, versionId: game.versionId, gameDirectory };
          }
          if (name === "stop_game") {
            const gameId = String(args?.gameId);
            const game = runningGames.get(gameId);
            if (!game) throw { code: "game.notRunning", params: {} };
            runningGames.delete(gameId);
            emit("launcher://games", [...runningGames.values()]);
            // Match native: controller processes the successful Stop response before the exit notification.
            setTimeout(() => emit("launcher://game-exit", { gameId, pid: game.pid, code: 0 }), 0);
            return { status: "stopped" };
          }
          if (name === "list_instance_backups") return { backups: [], warnings: [], recovery: null };
          if (name === "list_local_resources") return structuredClone(localResourceSets.get(localResourceKey(args)) ?? []);
          if (name === "toggle_resource") {
            const key = localResourceKey(args);
            const files = localResourceSets.get(key) ?? [];
            const fileName = String(args?.fileName ?? "");
            const index = files.findIndex(file => file.fileName === fileName);
            if (index < 0) throw { code: "resource.unavailable", params: {} };
            const file = files[index];
            const nextName = file.enabled
              ? `${file.fileName}.disabled`
              : file.fileName.replace(/\.disabled$/, "");
            const toggled: LocalResource = {
              ...file,
              enabled: !file.enabled,
              fileName: nextName,
              path: file.path.slice(0, file.path.length - file.fileName.length) + nextName,
            };
            localResourceSets.set(key, files.map((item, itemIndex) => itemIndex === index ? toggled : item));
            return structuredClone(toggled);
          }
          if (name === "delete_local_resources") {
            const key = localResourceKey(args);
            const files = localResourceSets.get(key) ?? [];
            const requested = Array.isArray(args?.fileNames) ? args.fileNames.map(String) : [];
            const removeSet = new Set(requested);
            const deleted = files.filter(file => removeSet.has(file.fileName)).map(file => file.fileName);
            localResourceSets.set(key, files.filter(file => !removeSet.has(file.fileName)));
            return { deleted };
          }
          if (name === "import_local_resources") {
            const key = localResourceKey(args);
            const existing = localResourceSets.get(key) ?? [];
            const paths = Array.isArray(args?.paths) ? args.paths.map(String) : [];
            const added: LocalResource[] = paths.map((rawPath) => {
              const fileName = rawPath.split(/[\\/]/).filter(Boolean).pop() ?? rawPath;
              const nameOnly = fileName.replace(/\.(jar|zip)$/i, "");
              return { name: nameOnly, fileName, path: rawPath, enabled: true, size: 4096, modifiedMs: Date.now() };
            });
            localResourceSets.set(key, [...existing, ...added]);
            return added.map((item) => ({ fileName: item.fileName, path: item.path, sizeBytes: item.size }));
          }
          if (name === "import_modpack") {
            const name = String(args?.name || "Dropped Pack");
            const imported = {
              ...instances[0],
              id: `fixture-pack-${instances.length + 1}`,
              name,
              versionId: "1.21.1",
              loader: "fabric",
              loaderVersion: "0.16.10",
            };
            instances.push(imported);
            return { instance: structuredClone(imported), warnings: [] };
          }
          if (name === "read_skin_preview") {
            return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
          }
          if (name === "check_network_environment") {
            return {
              checkedAt: "2026-11-25T08:00:00Z",
              ipv4: {
                available: true,
                localIp: "192.168.1.25",
                publicIp: "198.51.100.42",
                localPort: 50000,
                mappedPort: 61234,
                probesSucceeded: 2,
                rttMs: 22,
              },
              ipv6: {
                status: "globalPublic",
                localIp: "2409:8a00:1234::42",
                publicIp: "2409:8a00:1234::42",
                mappedPort: 50001,
                probesSucceeded: 2,
                rttMs: 18,
              },
              natType: "endpointIndependent",
              cgnatSuspected: false,
              directConnectIpv4: "198.51.100.42:25565",
              directConnectIpv6: "[2409:8a00:1234::42]:25565",
              stunHostsQueried: ["stun.cloudflare.com:3478", "stun.miwifi.com:3478"],
              advice: [
                { code: "ipv6DirectReady", severity: "good" },
                { code: "ipv4ConeForward", severity: "info" },
              ],
            };
          }
          if (name === "get_assistant_status") {
            const effectiveBaseUrl = config.assistantBaseUrl.trim() || (
              config.assistantProvider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"
            );
            const loopbackEndpoint = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(effectiveBaseUrl);
            return {
              apiKeyConfigured: assistantApiKeyConfigured,
              provider: config.assistantProvider,
              baseUrl: config.assistantBaseUrl,
              effectiveBaseUrl,
              model: config.assistantModel,
              permission: config.assistantPermission,
              proactive: config.assistantProactive,
              loopbackEndpoint,
              ready: Boolean(config.assistantModel.trim()) && (assistantApiKeyConfigured || loopbackEndpoint),
              mcp: {
                running: mcpRunning,
                port: mcpRunning ? mcpPort : config.assistantMcpPort,
                url: mcpRunning ? `http://127.0.0.1:${mcpPort}/mcp` : null,
                tokenMasked: mcpRunning ? `••••••••${mcpToken.slice(-6)}` : null,
              },
              tools: [
                { name: "list_instances", tier: "readOnly", description: "List registered instances." },
                { name: "update_instance_notes", tier: "controlled", description: "Update instance notes." },
              ],
            };
          }
          if (name === "set_assistant_api_key") {
            assistantApiKeyConfigured = Boolean(String(args?.secret ?? "").trim());
            return assistantApiKeyConfigured;
          }
          if (name === "start_mcp_server") {
            mcpPort = Number(args?.port ?? config.assistantMcpPort) || 25590;
            mcpRunning = true;
            return {
              running: true,
              port: mcpPort,
              url: `http://127.0.0.1:${mcpPort}/mcp`,
              tokenMasked: `••••••••${mcpToken.slice(-6)}`,
            };
          }
          if (name === "stop_mcp_server") {
            mcpRunning = false;
            return { running: false, port: config.assistantMcpPort, url: null, tokenMasked: null };
          }
          if (name === "rotate_mcp_token") {
            mcpToken = `synthetic-mcp-token-${Date.now().toString().slice(-6)}`;
            return {
              running: mcpRunning,
              port: mcpPort,
              url: mcpRunning ? `http://127.0.0.1:${mcpPort}/mcp` : null,
              tokenMasked: mcpRunning ? `••••••••${mcpToken.slice(-6)}` : null,
            };
          }
          if (name === "get_mcp_token") {
            return mcpRunning ? mcpToken : null;
          }
          if (name === "assistant_chat") {
            const req = (args?.request ?? {}) as {
              approvedCallIds?: string[];
              deniedCallIds?: string[];
              pendingContinuation?: unknown;
            };
            if (req.pendingContinuation) {
              const approved = (req.approvedCallIds ?? []).length > 0;
              return {
                reply: approved ? "已更新实例备注。" : "已按你的要求取消该写入操作。",
                traces: [
                  {
                    id: "call_notes_1",
                    name: "update_instance_notes",
                    arguments: { instanceId: instances[0]?.id ?? "fixture-instance-1", notes: "测试备注" },
                    tier: "controlled",
                    status: approved ? "approved" : "denied",
                    summary: approved ? "{\"notes\":\"测试备注\"}" : "User denied this action.",
                  },
                ],
                pendingApprovals: [],
                continuation: null,
                model: config.assistantModel || "gpt-4o-mini",
                provider: config.assistantProvider,
              };
            }
            if (config.assistantPermission === "controlled") {
              const pendingCall = {
                id: "call_notes_1",
                name: "update_instance_notes",
                arguments: { instanceId: instances[0]?.id ?? "fixture-instance-1", notes: "测试备注" },
                description: "Update the notes and/or category metadata of a registered instance.",
              };
              return {
                reply: "我已检查你的实例，准备写入备注。",
                traces: [
                  {
                    id: "call_list_1",
                    name: "list_instances",
                    arguments: {},
                    tier: "readOnly",
                    status: "executed",
                    summary: `{"count":${instances.length}}`,
                  },
                ],
                pendingApprovals: [pendingCall],
                continuation: {
                  provider: config.assistantProvider,
                  providerMessages: [],
                  completedResults: [],
                  pendingCalls: [pendingCall],
                  round: 0,
                },
                model: config.assistantModel || "gpt-4o-mini",
                provider: config.assistantProvider,
              };
            }
            return {
              reply: `当前共有 ${instances.length} 个实例。`,
              traces: [
                {
                  id: "call_list_1",
                  name: "list_instances",
                  arguments: {},
                  tier: "readOnly",
                  status: "executed",
                  summary: `{"count":${instances.length}}`,
                },
              ],
              pendingApprovals: [],
              continuation: null,
              model: config.assistantModel || "gpt-4o-mini",
              provider: config.assistantProvider,
            };
          }
          // These concrete query fixtures deliberately represent empty records.
          if ([
            "list_modpack_versions", "list_resource_update_history",
            "list_screenshots", "list_servers", "list_worlds", "list_world_datapacks", "read_managed_server_logs",
          ].includes(name)) return [];
          throw new Error(`Unhandled launcher fixture IPC: ${name}`);
        },
      },
    });
  }, { options, appearanceKeys: [...appearanceFields, "customBackground"] as const, appVersion: packageJson.version });
}
