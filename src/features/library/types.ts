import type { Instance } from "../../lib/launcher";

export type InstanceTab = "overview" | "content" | "worlds" | "logs" | "settings";
export type ResourceKind = "mod" | "resourcepack" | "shader";
export type ResourceView = "files" | "updates" | "history";
export type Loader = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge";

export interface LocalModMetadata {
  loader: "fabric" | "quilt" | "forge" | "neoforge" | "legacyForge";
  modId: string;
  name: string;
  version: string;
  description: string;
  authors: string[];
  hasIcon: boolean;
  dependencies: { id: string; kind: "required" | "optional" | "incompatible"; range: string }[];
  additionalMods: number;
}

export interface LocalResource {
  metadata?: LocalModMetadata;
  name: string;
  fileName: string;
  path: string;
  enabled: boolean;
  size: number;
  modifiedMs?: number;
}
export interface ResourceUpdate {
  fileName: string;
  name: string;
  currentVersion: string;
  newVersion: string;
  projectId: string;
  newVersionId: string;
  enabled: boolean;
  source: "modrinth" | "curseforge";
  /** CurseForge file id of the new version (CurseForge rows only). */
  newFileId?: number;
  /** The author forbids third-party downloads: the user must download it by hand. */
  manualOnly?: boolean;
  /** https://www.curseforge.com/... project page, present on manualOnly rows. */
  projectUrl?: string;
}
export interface ResourceUpdateCheck {
  updates: ResourceUpdate[];
  /** True when no CurseForge API key is configured, so CurseForge files were not checked. */
  curseforgeSkipped: boolean;
  /** CurseForge could not be checked (network or service failure); `updates` still holds the Modrinth rows. */
  curseforgeError?: string;
}
export interface ResourceHistory {
  updateId: string;
  name: string;
  createdAt: string;
  status: string;
  projects: string[];
  canRecover: boolean;
}
export interface RollbackResult {
  updateId: string;
  restoredFiles: number;
  status: string;
}
export interface World {
  folderName: string;
  name: string;
  lastPlayed?: number | null;
  gameMode?: string | null;
  hardcore: boolean;
  versionName?: string | null;
  dataVersion?: number | null;
  sizeBytes: number;
  iconDataUrl?: string | null;
  error?: string | null;
  warning?: string | null;
}
export interface Screenshot {
  fileName: string;
  sizeBytes: number;
  modifiedAt?: string | null;
}
export interface Preview {
  fileName: string;
  dataUrl: string;
}
export interface InstanceBackup {
  id: string;
  instanceId: string;
  versionId: string;
  createdAt: string;
  path: string;
  size: number;
}
export interface BackupRecoveryPaths {
  currentDirectory: string;
  previousDirectory?: string | null;
  restoredDirectory?: string | null;
  previousBackupId?: string | null;
  /** Which operation left the pending recovery record; absent old records are backup restores. */
  kind?: "backup" | "packUpdate";
}
export interface InstanceBackupList {
  backups: InstanceBackup[];
  warnings: { fileName: string; reason: "invalid" | "wrongInstance" | "unreadable" }[];
  recovery: BackupRecoveryPaths | null;
}
export interface RestoreInstanceBackupResult {
  instance: Instance;
  previousBackup: InstanceBackup | null;
  previousDirectory: string | null;
}
export interface RecoverInstanceRestoreResult {
  instance: Instance;
  preservedDirectory: string | null;
  previousBackup: InstanceBackup | null;
}
export type DiagnosisKind = "memory" | "java" | "mods" | "graphics" | "directory" | "unknown" | "empty";

export interface Diagnosis {
  kind: DiagnosisKind;
  logPath?: string | null;
  excerpt: string;
}
export interface LoaderVersion {
  id: string;
  stable: boolean;
  recommended?: boolean;
}
export interface LoaderResult {
  versionId: string;
  loader: string;
  loaderVersion: string;
}
export interface PackResult {
  instance: Instance;
  warnings: string[];
}
export interface ModpackVersion {
  id: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  datePublished: string;
}
export interface ModpackUpdateCheck {
  managed: boolean;
  /** Why it is not managed: no lock file, an old lock, a lock without its source, or a lock that cannot be read. */
  reason?: "noLock" | "legacyLock" | "noSource" | "invalidLock";
  current?: { versionId: string; versionNumber: string };
  /** Newer versions of the same pack, newest first (the existing ModpackVersion type above). */
  newer: ModpackVersion[];
  /** The installed version is no longer listed on its platform. */
  currentMissing: boolean;
  /** Whether the installed version included optional files (from its lock; false when not managed). */
  includeOptional: boolean;
}
export type PackConflictReason = "userModified" | "userDeleted" | "userAdded" | "userModifiedRemovedUpstream";
export interface PackUpdatePlan {
  from: { versionId: string; versionNumber: string };
  to: { versionId: string; versionNumber: string };
  add: number;
  replace: number;
  remove: number;
  unchanged: number;
  /** Paths where the user's change and the new version disagree; the default is to keep the user's file. */
  conflicts: { path: string; reason: PackConflictReason }[];
  /** Files the new version dropped that the user had disabled or deleted: that choice does not carry over to renamed files. */
  droppedIntents: string[];
  /** Files the user changed or deleted that the new version leaves as the installed version had them; kept as the user has them. Sorted paths. */
  kept: string[];
  /** Optional files on disk that the plan removes because optional files are not included. Sorted paths. */
  optionalRemoved: string[];
  /** Files the new version needs that CurseForge does not let the launcher download. Absent on older plans. */
  /** `target` is where to put the file (`.disabled` kept); `path` is the plan path. */
  manual?: { path: string; target: string; projectUrl: string; conflict: boolean }[];
  /** Paths left alone on purpose (saves, logs, screenshots, launcher files). */
  skipped: string[];
  dependencyChange: { from: Record<string, string>; to: Record<string, string> } | null;
  downloadBytes: number;
  includeOptional: boolean;
  fingerprint: string;
}
export interface PackUpdateResult {
  instance: Instance;
  previousBackup: InstanceBackup | null;
  /** The old directory, kept because it changed while the update ran. */
  previousDirectory?: string | null;
}
