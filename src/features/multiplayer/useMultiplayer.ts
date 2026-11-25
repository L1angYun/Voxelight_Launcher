import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { command, events } from "../../lib/launcher";
import { normalizeError, type LauncherError } from "../../lib/errors";
import { useLauncher } from "../../app/controller/LauncherProvider";

export interface ServerEntry {
  index: number;
  name: string;
  address: string;
  icon?: string;
  hideAddress: boolean;
  snapshot: string;
}

interface ServerEnvironment {
  versionId: string;
  gameDirectory: string;
  versionIsolation: boolean;
}

interface ServerView {
  environment: ServerEnvironment;
  rows: ServerEntry[] | null;
  loading: boolean;
}

interface ServerFeedback {
  environment: ServerEnvironment;
  error: LauncherError | null;
  notice: string;
}

interface ServerActivity {
  environment: ServerEnvironment;
  key: string;
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
  source: "vanilla" | "imported";
  software: string | null;
  jar: string | null;
  argsFile?: string | null;
}

export type ServerImportKind = "jar" | "folder";

export interface ServerImportInspection {
  kind: ServerImportKind;
  software: string | null;
  minecraftVersion: string | null;
  jars: string[];
  /** What each JAR says about itself, in the order of `jars`. */
  details: { jar: string; software: string | null; minecraftVersion: string | null }[];
  defaultJar: string | null;
  argsFile?: string | null;
  totalBytes: number;
  fileCount: number;
  unsupported: "installer" | "argsFile" | "noJar" | "needsFolder" | null;
}

export interface ManagedServerImportRequest {
  kind: ServerImportKind;
  path: string;
  name: string;
  versionId: string;
  jar: string;
  argsFile?: string | null;
}

export interface ServerLog {
  serverId: string;
  timestamp: string;
  stream: string;
  message: string;
}

export type NatType =
  | "openInternet"
  | "endpointIndependent"
  | "addressPortDependent"
  | "behindNat"
  | "unreachable";

export type Ipv6Status =
  | "globalPublic"
  | "behindNat6"
  | "localOnly"
  | "unavailable";

export interface NetworkAdvice {
  code: string;
  severity: "good" | "info" | "warn";
}

export interface Ipv4Report {
  available: boolean;
  localIp: string | null;
  publicIp: string | null;
  localPort: number | null;
  mappedPort: number | null;
  probesSucceeded: number;
  rttMs: number | null;
}

export interface Ipv6Report {
  status: Ipv6Status;
  localIp: string | null;
  publicIp: string | null;
  mappedPort: number | null;
  probesSucceeded: number;
  rttMs: number | null;
}

export interface NetworkCheckReport {
  checkedAt: string;
  ipv4: Ipv4Report;
  ipv6: Ipv6Report;
  natType: NatType;
  cgnatSuspected: boolean;
  directConnectIpv4: string | null;
  directConnectIpv6: string | null;
  stunHostsQueried: string[];
  advice: NetworkAdvice[];
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
  const [tab, setTab] = useState<"servers" | "managed" | "network">("servers");
  const environment = useMemo<ServerEnvironment>(() => ({
    versionId: selectedVersionId,
    gameDirectory: data.config.gameDirectory,
    versionIsolation: data.config.versionIsolation,
  }), [selectedVersionId, data.config.gameDirectory, data.config.versionIsolation]);
  const environmentRef = useRef(environment);
  const serverGeneration = useRef(0);
  const currentView = useRef<ServerView | null>(null);
  const currentActivity = useRef<ServerActivity | null>(null);
  const [serverView, setServerView] = useState<ServerView | null>(null);
  const [serverActivity, setServerActivity] = useState<ServerActivity | null>(null);
  const [serverFeedback, setServerFeedback] = useState<ServerFeedback | null>(null);
  const [serverStatus, setServerStatus] = useState<{ environment: ServerEnvironment; results: Record<string, ServerStatus> } | null>(null);
  const [serverLan, setServerLan] = useState<{ environment: ServerEnvironment; results: LanWorld[] } | null>(null);
  const [managedServers, setManagedServers] = useState<ManagedServer[]>([]);
  const [selectedManagedId, setSelectedManagedId] = useState("");
  const [logs, setLogs] = useState<ServerLog[]>([]);
  const [networkReport, setNetworkReport] = useState<NetworkCheckReport | null>(null);
  const [networkBusy, setNetworkBusy] = useState(false);
  const [networkError, setNetworkError] = useState<LauncherError | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<LauncherError | null>(null);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const selectedRef = useRef(selectedManagedId);
  const logGeneration = useRef(0);
  selectedRef.current = selectedManagedId;
  const currentManaged = managedServers.find((server) => server.id === selectedManagedId);
  const visibleView = serverView?.environment === environment ? serverView : null;
  const visibleFeedback = serverFeedback?.environment === environment ? serverFeedback : null;
  const visibleActivity = serverActivity?.environment === environment ? serverActivity : null;
  const relevantStatus = serverStatus?.environment === environment ? serverStatus.results : {};
  const relevantLan = serverLan?.environment === environment ? serverLan.results : null;

  useLayoutEffect(() => {
    environmentRef.current = environment;
  }, [environment]);

  const acceptsEnvironment = useCallback(() => mounted.current && environmentRef.current === environment, [environment]);
  const publishView = useCallback((view: ServerView) => {
    currentView.current = view;
    setServerView(view);
  }, []);
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

  const refreshServers = useCallback(async (preserveFeedback = false) => {
    if (!environment.versionId || !acceptsEnvironment()) return;
    const generation = ++serverGeneration.current;
    const accepts = () => acceptsEnvironment() && serverGeneration.current === generation;
    publishView({ environment, rows: null, loading: true });
    if (!preserveFeedback) setServerFeedback(null);
    try {
      const rows = await command<ServerEntry[]>("list_servers", { versionId: environment.versionId });
      if (accepts()) publishView({ environment, rows, loading: false });
    } catch (cause) {
      if (accepts()) {
        publishView({ environment, rows: null, loading: false });
        if (!preserveFeedback) setServerFeedback({ environment, error: normalizeError(cause), notice: "" });
      }
    }
  }, [acceptsEnvironment, environment, publishView]);

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
    void refreshServers();
    return () => { serverGeneration.current++; };
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

  const runServerAction = useCallback(async <T,>(
    key: string,
    action: () => Promise<T>,
    publishResult: (result: T) => void,
    successNotice = "",
  ): Promise<T | undefined> => {
    if (!acceptsEnvironment() || currentActivity.current?.environment === environment) return;
    const activity = { environment, key };
    currentActivity.current = activity;
    setServerActivity(activity);
    setServerFeedback(null);
    const accepts = () => acceptsEnvironment() && currentActivity.current === activity;
    try {
      const result = await action();
      if (!accepts()) return;
      publishResult(result);
      if (successNotice) setServerFeedback({ environment, error: null, notice: successNotice });
      return result;
    } catch (cause) {
      if (accepts()) {
        const failure = normalizeError(cause);
        setServerFeedback({ environment, error: failure, notice: "" });
        if (failure.code === "server.snapshotChanged") await refreshServers(true);
      }
      return undefined;
    } finally {
      if (currentActivity.current === activity) {
        currentActivity.current = null;
        if (mounted.current) setServerActivity(null);
      }
    }
  }, [acceptsEnvironment, environment, refreshServers]);

  const currentRows = () => {
    const view = currentView.current;
    return view?.environment === environment ? view.rows : null;
  };
  const hasBookmark = (bookmark: ServerEntry) => currentRows()
    ?.some((row) => row.index === bookmark.index && row.snapshot === bookmark.snapshot);
  const publishUpdatedList = (rows: ServerEntry[]) => {
    serverGeneration.current++;
    publishView({ environment, rows, loading: false });
  };

  const saveServer = (name: string, address: string) => currentRows() !== null ? runServerAction(
    "save-server",
    () => command<ServerEntry[]>("save_server", {
      versionId: environment.versionId,
      entry: { name, address, hideAddress: false },
    }),
    publishUpdatedList,
    "serverSaved",
  ) : Promise.resolve(undefined);

  const removeServer = (bookmark: ServerEntry) => hasBookmark(bookmark) ? runServerAction(
    "remove-server",
    () => command<ServerEntry[]>("remove_server", {
      versionId: environment.versionId,
      index: bookmark.index,
      expected: { index: bookmark.index, snapshot: bookmark.snapshot },
    }),
    publishUpdatedList,
    "serverRemoved",
  ) : Promise.resolve(undefined);

  const pingServer = (bookmark: ServerEntry) => hasBookmark(bookmark) ? runServerAction(
    `ping-${bookmark.address}`,
    () => command<ServerStatus>("ping_server", { address: bookmark.address }),
    (result) => setServerStatus((previous) => ({
      environment,
      results: { ...(previous?.environment === environment ? previous.results : {}), [bookmark.address]: result },
    })),
  ) : Promise.resolve(undefined);

  const discoverLan = () => runServerAction(
    "lan",
    () => command<LanWorld[]>("discover_lan"),
    (results) => setServerLan({ environment, results }),
  );

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

  const inspectImport = useCallback((kind: ServerImportKind, path: string) => perform(
    "inspect-import",
    () => command<ServerImportInspection>("inspect_server_import", { kind, path }),
  ), [perform]);

  const importManaged = useCallback((request: ManagedServerImportRequest) => managedRun(
    "import-managed",
    async () => {
      const result = await command<ManagedServer>("import_managed_server", { request });
      setSelectedManagedId(result.id);
      return result;
    },
    "serverImported",
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

  const runNetworkCheck = useCallback(async () => {
    setNetworkBusy(true);
    setNetworkError(null);
    try {
      const result = await command<NetworkCheckReport>("check_network_environment");
      if (mounted.current) setNetworkReport(result);
      return result;
    } catch (cause) {
      if (mounted.current) setNetworkError(normalizeError(cause));
      return undefined;
    } finally {
      if (mounted.current) setNetworkBusy(false);
    }
  }, []);

  return {
    tab,
    setTab,
    servers: visibleView?.rows ?? [],
    serverEnvironment: environment,
    serverLoading: Boolean(environment.versionId) && (visibleView === null || visibleView.loading),
    serverReady: visibleView?.rows != null,
    status: relevantStatus,
    lan: relevantLan ?? [],
    lanSearched: relevantLan !== null,
    managedServers,
    selectedManagedId,
    setSelectedManagedId,
    currentManaged,
    logs,
    networkReport,
    networkBusy,
    runNetworkCheck,
    busy: tab === "servers" ? visibleActivity?.key ?? "" : tab === "network" ? (networkBusy ? "network-check" : "") : busy,
    error: tab === "servers" ? visibleFeedback?.error ?? null : tab === "network" ? networkError : error,
    notice: tab === "servers" ? visibleFeedback?.notice ?? "" : tab === "network" ? "" : notice,
    launchNotice,
    dismissNotice,
    report,
    manifest,
    installedVersions: data.installedVersions,
    selectedVersionId,
    selectVersion,
    refreshServers: () => currentActivity.current?.environment === environment ? undefined : refreshServers(),
    refreshManaged,
    saveServer,
    removeServer,
    pingServer,
    discoverLan,
    join: (address: string) => acceptsEnvironment() && environment.versionId
      ? launchMultiplayer(environment.versionId, address) : undefined,
    joinBookmark: (bookmark: ServerEntry) => hasBookmark(bookmark) && acceptsEnvironment()
      ? launchMultiplayer(environment.versionId, bookmark.address) : undefined,
    createManaged,
    inspectImport,
    importManaged,
    updateManaged,
    setEula,
    startManaged,
    stopManaged,
    sendManagedCommand,
  };
}
