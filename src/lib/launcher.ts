import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DefaultSkinId } from "./defaultSkin";
import type { WorldMaterial, WorldSceneId } from "../components/world/types";
import { LauncherError, normalizeError } from "./errors";

export type EffectsLevel = "lite" | "full";
export type AccentSource = "voxelight" | "system" | "custom";

export interface SystemAppearance {
  accentColor: string;
  animationsEnabled: boolean;
  advancedEffectsEnabled: boolean;
  locale: string;
}

export interface Config {
  gameDirectory: string;
  javaPath: string;
  maxMemoryMb: number;
  jvmArguments: string;
  versionIsolation: boolean;
  theme: "dark" | "light" | "system";
  downloadConcurrency: number;
  microsoftClientId: string;
  downloadLimitKib: number;
  downloadSource: string;
  screenWidth: number;
  screenHeight: number;
  language: string;
  accentColor: string;
  effects: EffectsLevel;
  worldScene: WorldSceneId;
  worldMaterial: WorldMaterial;
  accentSource: AccentSource;
  soundEnabled: boolean;
  customBackground?: string | null;
  javaAutoDownload: boolean;
  defaultSkin: DefaultSkinId;
}
export interface Account {
  id: string;
  username: string;
  uuid: string;
  type: string;
  isSelected: boolean;
  expiresAt?: number | null;
  skinUrl?: string | null;
  skinModel?: string | null;
  authlibServer?: string | null;
}
export interface Instance {
  id: string;
  name: string;
  versionId: string;
  gameDirectory: string;
  createdAt: string;
  lastPlayed?: string;
  category: string;
  iconPath?: string | null;
  notes: string;
  maxMemoryMb?: number | null;
  javaPath?: string | null;
  jvmArguments?: string | null;
  screenWidth?: number | null;
  screenHeight?: number | null;
  totalPlayTime: number;
  loader: string;
  loaderVersion: string;
}
export interface InstalledVersion {
  id: string;
  type: string;
  installed: boolean;
  launchable: boolean;
  reason?: string;
  javaMajor?: number;
}
export interface RunningGame {
  pid: number;
  versionId: string;
  instanceId?: string | null;
  gameDirectory?: string;
  startedAt?: string;
}
export interface RemoteVersion {
  id: string;
  type: string;
  releaseTime: string;
  url: string;
}
export interface VersionManifest {
  latestRelease: string;
  latestSnapshot: string;
  versions: RemoteVersion[];
}
export interface JavaRuntime {
  path: string;
  version: string;
  major: number;
}
export interface Bootstrap {
  config: Config;
  accounts: Account[];
  instances: Instance[];
  installedVersions: InstalledVersion[];
  capabilities: Record<string, unknown>;
}
export interface Progress {
  operation: string;
  stage: string;
  completed: number;
  total: number;
  bytesCompleted: number;
  bytesTotal: number;
  message: string;
  versionId: string;
}
export interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
}

export const desktop = isTauri();
export async function command<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!desktop)
    throw new LauncherError(
      "desktop.required",
      {},
      "请使用桌面版执行此操作。浏览器预览无法访问本地游戏文件。",
    );
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    throw normalizeError(error);
  }
}
export function events<T>(name: string, callback: (value: T) => void) {
  return desktop
    ? listen<T>(name, (event) => callback(event.payload))
    : Promise.resolve(() => {});
}
export const defaults: Config = {
  gameDirectory: "",
  javaPath: "",
  maxMemoryMb: 4096,
  jvmArguments: "-XX:+UseG1GC",
  versionIsolation: true,
  theme: "system",
  downloadConcurrency: 6,
  microsoftClientId: "",
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
};

export interface ResourceProject {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  author: string;
  project_type: string;
  versions: string[];
  external_url?: string;
}
export async function searchResources(
  query: string,
  type: string,
  gameVersion?: string,
): Promise<ResourceProject[]> {
  const facets = [[`project_type:${type}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  const params = new URLSearchParams({
    query,
    limit: "24",
    index: "relevance",
    facets: JSON.stringify(facets),
  });
  const result = await fetch(`https://api.modrinth.com/v2/search?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!result.ok) throw new Error(`资源搜索失败（HTTP ${result.status}）`);
  return (await result.json()).hits;
}
