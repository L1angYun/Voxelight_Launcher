import { useCallback, useEffect, useRef, useState } from "react";
import {
  appearanceFields,
  command,
  configChanges,
  type AppearancePatch,
  defaults,
  events,
  type Bootstrap,
  type Config,
  type LogEntry,
  type Progress,
  type RunningGame,
  type VersionManifest,
} from "../../lib/launcher";
import { normalizeError } from "../../lib/errors";
import { useAccountSkin } from "../../lib/accountSkin";
import type { LauncherContextValue, LauncherNotice } from "./types";

const previewFields = [...appearanceFields, "customBackground"] as const;

interface LaunchRequest {
  reservation: Promise<string>;
  id?: string;
  cancelRequested: boolean;
  cancellation?: Promise<boolean>;
}

interface LaunchTarget {
  versionId: string;
  instanceId?: string;
  accountId: string;
  serverAddress?: string;
}

export function useLauncherController(): LauncherContextValue {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  const [data, setData] = useState<Bootstrap>({
    config: defaults,
    accounts: [],
    instances: [],
    installedVersions: [],
    capabilities: {},
  });
  const [config, setConfigValue] = useState<Config>(defaults);
  const canonicalConfig = useRef<Config>(defaults);
  const bootstrapGeneration = useRef(0);
  const [manifest, setManifest] = useState<VersionManifest | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>();
  const [running, setRunningGames] = useState<RunningGame[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [resourceProgress, setResourceProgress] = useState<Progress | null>(null);
  const launchRequest = useRef<LaunchRequest>(undefined);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<LauncherNotice | null>(null);
  const [gamePid, setGamePid] = useState<number>();
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const operationCount = useRef(0);

  const activeAccount = data.accounts.find((account) => account.isSelected);
  const selectedInstance = data.instances.find((instance) => instance.id === selectedInstanceId);
  const selectedVersion = data.installedVersions.find((version) => version.id === selectedVersionId);
  const selectedRunningGame = running.find((game) =>
    selectedInstanceId
      ? game.instanceId === selectedInstanceId
      : game.versionId === selectedVersionId && !game.instanceId,
  );
  const accountAppearance = useAccountSkin(activeAccount);

  const showNotice = useCallback(
    (
      code: string,
      kind: LauncherNotice["kind"] = "info",
      params?: Record<string, unknown>,
      error?: LauncherNotice["error"],
    ) => {
      setNotice({ code, kind, params, error });
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(
        () => setNotice(null),
        kind === "error" ? 11000 : 5000,
      );
    },
    [],
  );

  const dismissNotice = useCallback(() => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(null);
  }, []);

  const publishConfig = useCallback((saved: Config) => {
    const previous = canonicalConfig.current;
    canonicalConfig.current = saved;
    setConfigValue((current) => ({ ...saved, ...configChanges(previous, current) }));
  }, []);

  const setConfig = useCallback((next: Config) => {
    const current = canonicalConfig.current;
    // Preview and reset affect the visual layer. Do not reintroduce stale gameplay fields.
    const visual = Object.fromEntries(
      previewFields.filter((key) => !Object.is(current[key], next[key])).map((key) => [key, next[key]]),
    );
    setConfigValue({ ...current, ...visual });
  }, []);

  const reload = useCallback(async () => {
    const request = ++bootstrapGeneration.current;
    let result: Bootstrap;
    try {
      result = await command<Bootstrap>("bootstrap");
    } catch (error) {
      if (request === bootstrapGeneration.current) throw error;
      return;
    }
    if (request !== bootstrapGeneration.current) return;
    setData(result);
    publishConfig(result.config);
    setBootstrapped(true);
    setBootstrapFailed(false);
    setSelectedVersionId((previous) =>
      result.installedVersions.some((version) => version.id === previous)
        ? previous
        : (result.installedVersions[0]?.id ?? ""),
    );
    setSelectedInstanceId((previous) =>
      previous && result.instances.some((instance) => instance.id === previous)
        ? previous
        : undefined,
    );
  }, [publishConfig]);

  const run = useCallback(
    async <T,>(labelKey: string, action: () => Promise<T>): Promise<T | undefined> => {
      if (labelKey === "resource.install") setResourceProgress(null);
      operationCount.current += 1;
      setBusy((current) => current || labelKey);
      try {
        return await action();
      } catch (error) {
        const normalized = normalizeError(error);
        showNotice(normalized.code, "error", normalized.params, normalized);
        return undefined;
      } finally {
        operationCount.current -= 1;
        if (operationCount.current === 0) setBusy("");
      }
    },
    [showNotice],
  );

  const saveConfig = useCallback(
    async (next: Config, appearancePatch?: AppearancePatch) => {
      const saved = await run("settings.save", async () => {
        const value = appearancePatch
          ? await command<Config>("save_appearance_config", { patch: appearancePatch })
          : await command<Config>("save_config", { config: next });
        // A read initiated before this durable save cannot publish a stale snapshot.
        ++bootstrapGeneration.current;
        const previous = canonicalConfig.current;
        canonicalConfig.current = value;
        setData((current) => ({ ...current, config: value }));
        setConfigValue((current) => {
          const preview = configChanges(previous, current);
          const remaining = configChanges(next, { ...next, ...preview });
          return { ...value, ...remaining };
        });
        showNotice("settings.saved");
        return value;
      });
      return saved !== undefined;
    },
    [run, showNotice],
  );

  const selectInstance = useCallback(
    (id?: string) => {
      setSelectedInstanceId(id);
      const instance = data.instances.find((candidate) => candidate.id === id);
      if (instance) setSelectedVersionId(instance.versionId);
    },
    [data.instances],
  );

  const selectVersion = useCallback((id: string) => {
    setSelectedVersionId(id);
    setSelectedInstanceId(undefined);
  }, []);

  const startLaunch = useCallback(async (target: LaunchTarget) => {
    if (launchRequest.current) return;
    const { versionId, instanceId } = target;
    const request: LaunchRequest = {
      reservation: Promise.resolve().then(() =>
        command<string>("reserve_launch_task", { versionId, ...(instanceId ? { instanceId } : {}) })),
      cancelRequested: false,
    };
    launchRequest.current = request;
    setProgress(null);
    setPreparing(true);
    const result = await run("game.prepare", async () => {
      try {
        request.id = await request.reservation;
        if (request.cancelRequested) {
          await request.cancellation;
          return;
        }
        return await command<{ pid: number }>("launch_game", { ...target, taskId: request.id });
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code !== "download.cancelled") {
          // The backend normally closes its own row. A dispatch failure can
          // precede admission, so release just this request's reservation.
          if (request.id && !request.cancelRequested) {
            void command("cancel_download_task", { taskId: request.id }).catch(() => {});
          }
          throw normalized;
        }
        if (!request.cancelRequested) showNotice("preparation.cancelRequested");
      }
    }).finally(() => {
      if (launchRequest.current === request) {
        launchRequest.current = undefined;
        setProgress(null);
        setPreparing(false);
      }
    });
    if (result) {
      setGamePid(result.pid);
      showNotice("game.launched");
      await reload();
    }
  }, [reload, run, showNotice]);

  const launch = useCallback(async (instanceId?: string, versionId?: string) => {
    const launchInstanceId = versionId ? undefined : instanceId ?? selectedInstanceId;
    const launchVersionId = versionId ?? (instanceId
      ? data.instances.find((instance) => instance.id === instanceId)?.versionId ?? selectedVersionId
      : selectedVersionId);
    if (!activeAccount) {
      showNotice("auth.required", "error");
      return;
    }
    if (!launchVersionId) {
      showNotice("instance.required", "error");
      return;
    }
    await startLaunch({ versionId: launchVersionId, instanceId: launchInstanceId, accountId: activeAccount.id });
  }, [activeAccount, data.instances, selectedInstanceId, selectedVersionId, showNotice, startLaunch]);

  const stop = useCallback(async () => {
    const pid = selectedRunningGame?.pid ?? gamePid;
    if (pid === undefined) {
      showNotice("game.notRunning", "error");
      return;
    }
    const result = await run("game.stop", async () => {
      await command("stop_game", { pid });
      const games = await command<RunningGame[]>("list_running_games");
      return { games, pid };
    });
    if (!result) return;
    setRunningGames(result.games);
    if (result.games.some((game) => game.pid === pid)) {
      showNotice("game.stopRequested");
      return;
    }
    setGamePid((current) => (current === pid ? undefined : current));
    showNotice("game.stopped");
  }, [gamePid, run, selectedRunningGame?.pid, showNotice]);

  const launchMultiplayer = useCallback(async (versionId: string, serverAddress: string) => {
    if (!activeAccount) {
      showNotice("auth.required", "error");
      return;
    }
    if (!versionId) {
      showNotice("instance.required", "error");
      return;
    }
    await startLaunch({ versionId, serverAddress, accountId: activeAccount.id });
  }, [activeAccount, showNotice, startLaunch]);

  const cancelPreparation = useCallback(async () => {
    const request = launchRequest.current;
    if (!request || request.cancellation) return;
    request.cancelRequested = true;
    request.cancellation = run("preparation.cancel", async () => {
      const taskId = await request.reservation.catch(() => undefined);
      if (!taskId) return false; // The launch itself owns the reservation error.
      await command("cancel_download_task", { taskId });
      if (launchRequest.current === request) showNotice("preparation.cancelRequested");
      return true;
    }).then(Boolean);
    if (!await request.cancellation && launchRequest.current === request) {
      request.cancelRequested = false;
      request.cancellation = undefined;
    }
  }, [run, showNotice]);

  useEffect(() => {
    let active = true;
    void reload().catch((error) => {
      if (!active) return;
      setBootstrapFailed(true);
      const normalized = normalizeError(error);
      showNotice(normalized.code, "error", normalized.params, normalized);
    });
    void command<VersionManifest>("list_versions")
      .then(setManifest)
      .catch((error) => {
        const normalized = normalizeError(error);
        if (normalized.code !== "desktop.required") showNotice("versions.unavailable", "error", {}, normalized);
      });
    void command<RunningGame[]>("list_running_games")
      .then(setRunningGames)
      .catch(() => {});
    const disposers = [
      events<RunningGame[]>("launcher://games", setRunningGames),
      events<Progress>("launcher://progress", (event) => {
        if (!active) return;
        if (event.operation === "resource") setResourceProgress(event);
        const request = launchRequest.current;
        if (event.operation === "launch" && request?.id && event.taskId === request.id && !request.cancelRequested) {
          setProgress(event);
        }
      }),
      events<LogEntry>("launcher://log", (item) =>
        setLogs((previous) => [...previous.slice(-399), item]),
      ),
      events<{ pid: number; code: number }>("launcher://game-exit", (result) => {
        setGamePid(undefined);
        showNotice("game.exited", "info", { code: result.code });
      }),
    ];
    return () => {
      active = false;
      ++bootstrapGeneration.current;
      for (const promise of disposers) void promise.then((dispose) => dispose());
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [reload, showNotice]);

  return {
    bootstrapped,
    bootstrapFailed,
    data,
    config,
    manifest,
    activeAccount,
    accountAppearance,
    selectedInstance,
    selectedVersion,
    selectedVersionId,
    selectedRunningGame,
    running,
    preparing,
    progress,
    resourceProgress,
    logs,
    busy,
    notice,
    gamePid,
    reload,
    saveConfig,
    setConfig,
    selectInstance,
    selectVersion,
    launch,
    launchMultiplayer,
    stop,
    cancelPreparation,
    run,
    dismissNotice,
  };
}
