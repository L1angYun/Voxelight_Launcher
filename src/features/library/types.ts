import type { Instance } from "../../lib/launcher";

export type InstanceTab = "overview" | "content" | "worlds" | "logs" | "settings";
export type ResourceKind = "mod" | "resourcepack" | "shader";
export type ResourceView = "files" | "updates" | "history";
export type Loader = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge";

export interface LocalResource {
  name: string;
  fileName: string;
  path: string;
  enabled: boolean;
  size: number;
}
export interface ResourceUpdate {
  fileName: string;
  name: string;
  currentVersion: string;
  newVersion: string;
  projectId: string;
  newVersionId: string;
  enabled: boolean;
}
export interface ResourceHistory {
  updateId: string;
  name: string;
  createdAt: string;
  status: string;
  projects: string[];
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
export interface Diagnosis {
  title: string;
  reason: string;
  suggestions: string[];
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
