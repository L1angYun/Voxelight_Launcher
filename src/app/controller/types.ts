import type {
  Account,
  Bootstrap,
  Config,
  InstalledVersion,
  Instance,
  LogEntry,
  Progress,
  RunningGame,
  VersionManifest,
} from "../../lib/launcher";
import type { LauncherError } from "../../lib/errors";
import type { useAccountSkin } from "../../lib/accountSkin";

export interface LauncherNotice {
  kind: "info" | "error";
  code: string;
  params?: Record<string, unknown>;
  error?: LauncherError;
}

export interface LauncherContextValue {
  /** A native bootstrap snapshot has arrived; defaults alone are not user preferences. */
  bootstrapped: boolean;
  /** Only the initial bootstrap has failed; regular reloads keep usable pages. */
  bootstrapFailed?: boolean;
  data: Bootstrap;
  config: Config;
  manifest: VersionManifest | null;
  activeAccount?: Account;
  accountAppearance: ReturnType<typeof useAccountSkin>;
  selectedInstance?: Instance;
  selectedVersion?: InstalledVersion;
  selectedVersionId: string;
  selectedRunningGame?: RunningGame;
  running: RunningGame[];
  progress: Progress | null;
  logs: LogEntry[];
  busy: string;
  notice: LauncherNotice | null;
  gamePid?: number;
  reload(): Promise<void>;
  saveConfig(next: Config): Promise<boolean>;
  setConfig(next: Config): void;
  selectInstance(id?: string): void;
  selectVersion(id: string): void;
  launch(instanceId?: string, versionId?: string): Promise<void>;
  launchMultiplayer(versionId: string, serverAddress: string): Promise<void>;
  stop(): Promise<void>;
  cancelPreparation(): Promise<void>;
  run<T>(labelKey: string, action: () => Promise<T>): Promise<T | undefined>;
  dismissNotice(): void;
}
