import { useCallback, useEffect, useRef, useState } from "react";
import { command, events } from "../../lib/launcher";
import { normalizeError, type LauncherError } from "../../lib/errors";
import { useLauncher } from "../../app/controller/LauncherProvider";

export interface ServerEntry {
  index: number;
  name: string;
  address: string;
  icon?: string;
  hideAddress: boolean;
}

export interface ServerStatus {
  online: boolean;
  latencyMs?: number;
  version?: string;
  playersOnline?: number;
  playersMax?: number;
  description: string;
  error?: string;
}

export interface LanWorld {
  motd: string;
  address: string;
  port: number;
}

export interface ServerSettings {
  port: number;
  maxPlayers: number;
  onlineMode: boolean;
  whitelist: boolean;
  motd: string;
  difficulty: string;
  gamemode: string;
  viewDistance: number;
  maxMemoryMb: number;
  bindAddress: string;
}

export interface ManagedServer {
  id: string;
  name: string;
  versionId: string;
  createdAt: string;
  directory: string;
  settings: ServerSettings;
  eulaAccepted: boolean;
  eulaUrl: string;
  installed: boolean;
  status: string;
  pid: number | null;
  exitCode: number | null;
  error: string | null;
  javaMajor: number | null;
}

export interface ServerLog {
  serverId: string;
  timestamp: string;
  stream: string;
  message: string;
}

export const defaultServerSettings: ServerSettings = {
  port: 25565,
  maxPlayers: 20,
  onlineMode: true,
  whitelist: false,
  motd: "A Minecraft Server",
  difficulty: "normal",
  gamemode: "survival",
  viewDistance: 10,
  maxMemoryMb: 2048,
  bindAddress: "",
};

function mergeLogs(previous: ServerLog[], incoming: ServerLog[]): ServerLog[] {
  const all = new Map(
    [...previous, ...incoming].map((log) => [
      `${log.serverId}|${log.timestamp}|${log.stream}|${log.message}`,
      log,
    ]),
  );
  return [...all.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-500);
}

export function useMultiplayer() {
  const {
    data,
    manifest,
    selectedVersionId,
    selectVersion,
    launchMultiplayer,
    notice: launchNotice,
    dismissNotice,
  } = useLauncher();
  const [tab, setTab] = useState<"servers" | "managed">("servers");
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [status, setStatus] = useState<Record<string, ServerStatus>>({});
  const [lan, setLan] = useState<LanWorld[]>([]);
  const [lanSearched, setLanSearched] = useState(false);
  const [managedServers, setManagedServers] = useState<ManagedServer[]>([]);
  const [selectedManagedId, setSelectedManagedId] = useState("");
  const [logs, setLogs] = useState<ServerLog[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<LauncherError | null>(null);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const selectedRef = useRef(selectedManagedId);
  const logGeneration = useRef(0);
  selectedRef.current = selectedManagedId;
  const currentManaged = managedServers.find((server) => server.id === selectedManagedId);
  const report = useCallback((cause: unknown) => {
    if (mounted.current) setError(normalizeError(cause));
  }, []);

  const perform = useCallback(async <T,>(
    key: string,
    action: () => Promise<T>,
    successNotice = "",
  ): Promise<T | undefined> => {
    setBusy(key);
    setError(null);
    setNotice("");
    try {
      const result = await action();
      if (mounted.current && successNotice) setNotice(successNotice);
      return result;
    } catch (cause) {
      if (mounted.current) setError(normalizeError(cause));
      return undefined;
    } finally {
      if (mounted.current) setBusy("");
    }
  }, []);

  const refreshServers = useCallback(async () => {
    if (!selectedVersionId) {
      setServers([]);
      return;
    }
    try {
      const result = await command<ServerEntry[]>("list_servers", { versionId: selectedVersionId });
      if (mounted.current) setServers(result);
    } catch (cause) {
      if (mounted.current) setError(normalizeError(cause));
    }
  }, [selectedVersionId]);

  const refreshManaged = useCallback(async () => {
    try {
      const values = await command<ManagedServer[]>("list_managed_servers");
      if (!mounted.current) return;
      setManagedServers(values);
      setSelectedManagedId((previous) => values.some((value) => value.id === previous) ? previous : values[0]?.id ?? "");
    } catch (cause) {
      if (mounted.current) setError(normalizeError(cause));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refreshManaged();
    const logDisposer = events<ServerLog>("launcher://server-log", (log) => {
      if (mounted.current && log.serverId === selectedRef.current) {
        setLogs((previous) => mergeLogs(previous, [log]));
      }
    });
    const stateDisposer = events<{ serverId: string }>("launcher://server-state", () => {
      if (mounted.current) void refreshManaged();
    });
    return () => {
      mounted.current = false;
      void logDisposer.then((dispose) => dispose());
      void stateDisposer.then((dispose) => dispose());
    };
  }, [refreshManaged]);

  useEffect(() => {
    setStatus({});
    setLan([]);
    setLanSearched(false);
    void refreshServers();
  }, [refreshServers]);

  useEffect(() => {
    const request = ++logGeneration.current;
    setLogs([]);
    if (selectedManagedId) {
      void command<ServerLog[]>("read_managed_server_logs", { serverId: selectedManagedId, limit: 200 })
        .then((values) => {
          if (mounted.current && logGeneration.current === request) setLogs((previous) => mergeLogs(previous, values));
        })
        .catch((cause) => {
          if (mounted.current) setError(normalizeError(cause));
        });
    }
    return () => {
      logGeneration.current++;
    };
  }, [selectedManagedId]);

  const managedRun = useCallback(async <T,>(key: string, action: () => Promise<T>, successNotice = "") => {
    const result = await perform(key, action, successNotice);
    await refreshManaged();
    return result;
  }, [perform, refreshManaged]);

  const saveServer = useCallback((name: string, address: string) => perform(
    "save-server",
    async () => {
      const result = await command<ServerEntry[]>("save_server", {
        versionId: selectedVersionId,
        entry: { index: 0, name, address, hideAddress: false },
      });
      setServers(result);
      return result;
    },
    "serverSaved",
  ), [perform, selectedVersionId]);

  const removeServer = useCallback((index: number) => perform(
    "remove-server",
    async () => {
      const result = await command<ServerEntry[]>("remove_server", { versionId: selectedVersionId, index });
      setServers(result);
      return result;
    },
    "serverRemoved",
  ), [perform, selectedVersionId]);

  const pingServer = useCallback((address: string) => perform(
    `ping-${address}`,
    async () => {
      const result = await command<ServerStatus>("ping_server", { address });
      setStatus((previous) => ({ ...previous, [address]: result }));
      return result;
    },
  ), [perform]);

  const discoverLan = useCallback(async () => {
    const result = await perform("lan", () => command<LanWorld[]>("discover_lan"));
    if (result !== undefined) {
      setLan(result);
      setLanSearched(true);
    }
  }, [perform]);

  const createManaged = useCallback((name: string, versionId: string) => managedRun(
    "create-managed",
    async () => {
      const result = await command<ManagedServer>("create_managed_server", {
        request: { name: name.trim(), versionId, settings: { ...defaultServerSettings } },
      });
      setSelectedManagedId(result.id);
      return result;
    },
    "serverCreated",
  ), [managedRun]);

  const updateManaged = useCallback((settings: ServerSettings) => managedRun(
    "update-managed",
    () => command("update_managed_server", { serverId: selectedManagedId, settings }),
    "settingsSaved",
  ), [managedRun, selectedManagedId]);

  const setEula = useCallback((accepted: boolean) => managedRun(
    "eula-managed",
    () => command("set_managed_server_eula", { serverId: selectedManagedId, accepted }),
  ), [managedRun, selectedManagedId]);

  const startManaged = useCallback(() => managedRun(
    "start-managed",
    () => command("start_managed_server", { serverId: selectedManagedId }),
  ), [managedRun, selectedManagedId]);

  const stopManaged = useCallback((force: boolean) => managedRun(
    "stop-managed",
    () => command("stop_managed_server", { serverId: selectedManagedId, force }),
    force ? "forceStopRequested" : "stopRequested",
  ), [managedRun, selectedManagedId]);

  const sendManagedCommand = useCallback((value: string) => managedRun(
    "command-managed",
    () => command("send_managed_server_command", { serverId: selectedManagedId, command: value }),
    "commandSent",
  ), [managedRun, selectedManagedId]);

  return {
    tab,
    setTab,
    servers,
    status,
    lan,
    lanSearched,
    managedServers,
    selectedManagedId,
    setSelectedManagedId,
    currentManaged,
    logs,
    busy,
    error,
    notice,
    launchNotice,
    dismissNotice,
    report,
    manifest,
    installedVersions: data.installedVersions,
    selectedVersionId,
    selectVersion,
    refreshServers,
    refreshManaged,
    saveServer,
    removeServer,
    pingServer,
    discoverLan,
    join: (address: string) => launchMultiplayer(selectedVersionId, address),
    createManaged,
    updateManaged,
    setEula,
    startManaged,
    stopManaged,
    sendManagedCommand,
  };
}
