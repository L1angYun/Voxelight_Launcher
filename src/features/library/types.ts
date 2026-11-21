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
