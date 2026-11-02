import { useCallback, useEffect, useRef, useState } from "react";
import {
  command,
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

export function useLauncherController(): LauncherContextValue {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [data, setData] = useState<Bootstrap>({
    config: defaults,
    accounts: [],
    instances: [],
    installedVersions: [],
    capabilities: {},
  });
  const [config, setConfig] = useState<Config>(defaults);
  const [manifest, setManifest] = useState<VersionManifest | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>();
  const [running, setRunningGames] = useState<RunningGame[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
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

  const reload = useCallback(async () => {
    const result = await command<Bootstrap>("bootstrap");
    setData(result);
    setConfig(result.config);
    setBootstrapped(true);
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
  }, []);

  const run = useCallback(
    async <T,>(labelKey: string, action: () => Promise<T>): Promise<T | undefined> => {
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
    async (next: Config) => {
      const saved = await run("settings.save", async () => {
        const saved = await command<Config>("save_config", { config: next });
        setConfig(saved);
        setData((previous) => ({ ...previous, config: saved }));
        showNotice("settings.saved");
        return saved;
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
    const result = await run("game.prepare", () =>
      command<{ pid: number }>("launch_game", {
        versionId: launchVersionId,
        instanceId: launchInstanceId,
        accountId: activeAccount.id,
      }),
    );
    if (!result) return;
    setProgress(null);
    setGamePid(result.pid);
    showNotice("game.launched");
    await reload();
  }, [activeAccount, data.instances, reload, run, selectedInstanceId, selectedVersionId, showNotice]);

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
    const result = await run("game.prepare", () =>
      command<{ pid: number }>("launch_game", {
        versionId,
        serverAddress,
        accountId: activeAccount.id,
      }),
    );
    if (!result) return;
    setProgress(null);
    setGamePid(result.pid);
    showNotice("game.launched");
    await reload();
  }, [activeAccount, reload, run, showNotice]);

  const cancelPreparation = useCallback(async () => {
    await run("preparation.cancel", async () => {
      await command("cancel_download_task", { taskId: null });
      await command("set_download_paused", { paused: false });
      showNotice("preparation.cancelRequested");
    });
  }, [run, showNotice]);

  useEffect(() => {
    void reload().catch((error) => {
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
      events<Progress>("launcher://progress", setProgress),
      events<LogEntry>("launcher://log", (item) =>
        setLogs((previous) => [...previous.slice(-399), item]),
      ),
      events<{ pid: number; code: number }>("launcher://game-exit", (result) => {
        setGamePid(undefined);
        showNotice("game.exited", "info", { code: result.code });
      }),
    ];
    return () => {
      for (const promise of disposers) void promise.then((dispose) => dispose());
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [reload, showNotice]);

  return {
    bootstrapped,
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
    progress,
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
